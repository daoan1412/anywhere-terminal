// src/vault/readers/claudeRecords.ts — Bounded, defensive JSONL streaming +
// record-text extraction for the Claude reader (claudeReader split).
//
// Every loop skips a single corrupt line and keeps reading (D8); `streamClaudeRecords`
// is head+tail bounded so a tens-of-MB transcript never fully materializes (W1).

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { cleanPromptText, createBoundedRecordBuffer } from "./detail";

/** Cap on a workflow manifest read (review W5): manifests are normally tens-to-
 *  hundreds of KB; skip anything larger rather than materialize + parse it. */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/** Read + parse a workflow manifest, bounded by {@link MAX_MANIFEST_BYTES} and
 *  defensive (missing / oversized / malformed → null, never throws — D8). */
export async function readManifestJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) {
      return null;
    }
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce a record timestamp (ISO string, or epoch ms as number/string) to epoch
 *  ms, or undefined. Workflow manifests store `startTime` as a numeric string and
 *  records store ISO `timestamp`s — both must become finite numbers for the
 *  timeline merge to order them (D3). */
export function coerceTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) {
      return asNum; // epoch-ms string, e.g. "1780072409110"
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms; // ISO string
  }
  return undefined;
}

/** RAW user text (string content or joined text blocks), WITHOUT the
 *  command-wrapper stripping `extractUserText` applies — so a
 *  `<teammate-message …>` tag survives intact for boundary detection. */
export function rawUserText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(" ");
    return text || undefined;
  }
  return undefined;
}

export function extractUserText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return cleanPromptText(content);
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(" ")
      .trim();
    return text ? cleanPromptText(text) : undefined;
  }
  return undefined;
}

/** Bytes read from the file tail when hunting for the latest `ai-title`. */
const AI_TITLE_TAIL_BYTES = 64 * 1024;

/**
 * Claude's UI title is an `{type:"ai-title", aiTitle}` record that Claude
 * regenerates and re-appends near the end of the session as it evolves — the
 * LATEST one wins. Those records sit scattered to EOF (a 86MB file is common),
 * so the forward metadata scan never reaches them. Read only the last
 * `AI_TITLE_TAIL_BYTES` (the freshest title reliably lands at/near EOF) and
 * return the last `aiTitle` found there — bounded regardless of file size.
 */
export async function readLatestAiTitle(filePath: string): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const { size } = await handle.stat();
    if (size === 0) {
      return undefined;
    }
    const start = Math.max(0, size - AI_TITLE_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift(); // first line is likely truncated mid-record — drop it
    }
    let title: string | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === "object" && (obj as { type?: unknown }).type === "ai-title") {
          const value = (obj as { aiTitle?: unknown }).aiTitle;
          if (typeof value === "string" && value.trim()) {
            title = value.trim(); // keep walking — the last record is the freshest
          }
        }
      } catch {
        // skip a partial/corrupt line, keep scanning (D8)
      }
    }
    return title;
  } catch {
    return undefined; // unreadable tail → fall back to the first-prompt title
  } finally {
    await handle?.close();
  }
}

/**
 * Read parseable records from a session jsonl (skip-malformed, D8), bounded to a
 * head + tail window so a tens-of-MB transcript never fully materializes (W1).
 * Returns `truncated` when the middle was dropped.
 */
export async function streamClaudeRecords(
  filePath: string,
  opts: { onRecord?: (rec: Record<string, unknown>) => void } = {},
): Promise<{ records: Record<string, unknown>[]; truncated: boolean } | null> {
  const buffer = createBoundedRecordBuffer();
  let stream: ReturnType<typeof createReadStream> | undefined;
  let rl: readline.Interface | undefined;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
    rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          const rec = parsed as Record<string, unknown>;
          // Fire BEFORE buffering so a side-collector (e.g. teamName gathering,
          // D4) sees every record even when the head+tail bound later drops the
          // middle of a very large transcript (W1).
          opts.onRecord?.(rec);
          buffer.push(rec);
        }
      } catch {
        // skip a single corrupt line, keep reading (D8)
      }
    }
  } catch {
    return null; // stream/open failure → unreadable
  } finally {
    rl?.close();
    stream?.destroy();
  }
  return buffer.result();
}

/** Cheaply read a transcript's first user message text + timestamp (head only). */
export async function readFirstUserRecord(filePath: string): Promise<{ text: string; timestamp: number } | null> {
  let stream: ReturnType<typeof createReadStream> | undefined;
  let rl: readline.Interface | undefined;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
    rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type !== "user") {
        continue;
      }
      const text = extractUserText(obj.message);
      if (text) {
        const t = obj.timestamp;
        const ts = typeof t === "string" ? Date.parse(t) : typeof t === "number" ? t : Number.NaN;
        return { text, timestamp: Number.isNaN(ts) ? 0 : ts };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    rl?.close();
    stream?.destroy();
  }
}
