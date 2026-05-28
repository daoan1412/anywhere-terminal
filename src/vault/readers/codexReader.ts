// src/vault/readers/codexReader.ts — Read Codex sessions (SQLite + JSONL fallback).
// See: specs/agent-session-index/spec.md (Read Codex sessions), design.md D3,D8,
//      docs/research/20260528-cmux-vault-mechanism.md §4.
//
// Primary source is the `threads` table of ~/.codex/state_5.sqlite. When the DB
// or the sqlite3 tool is unavailable we fall back to scanning
// ~/.codex/sessions/**/*.jsonl (first line's session_meta). A query-error on the
// SQLite read is surfaced as unreadable rather than masked by the fallback.

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { boundedPreview } from "../preview";
import { readSqlite } from "../sqlite";
import type { VaultSessionEntry } from "../types";
import type { ReaderResult } from "./claudeReader";

/** Bound the SQLite read so the vault list stays cheap (D2). */
const ROW_LIMIT = 500;

const CODEX_THREADS_SQL = `SELECT id, rollout_path, cwd, title, model, git_branch,
       approval_mode, sandbox_policy, reasoning_effort,
       first_user_message, updated_at_ms
FROM threads
WHERE archived = 0
ORDER BY updated_at_ms DESC
LIMIT ${ROW_LIMIT}`;

export interface CodexReaderOptions {
  home?: string;
  /** Override `~/.codex`. */
  codexDir?: string;
  /** Injectable for tests; defaults to the real WAL-safe reader. */
  readSqliteFn?: typeof readSqlite;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") {
    return v || undefined;
  }
  if (typeof v === "number") {
    return String(v);
  }
  return undefined;
}

/** sandbox_policy is a JSON blob; we surface its `.type` (else the raw string). */
function parseSandbox(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string") {
      return (obj as { type: string }).type;
    }
  } catch {
    // not JSON — fall through to the raw value
  }
  return raw;
}

function mapThreadRow(row: Record<string, unknown>): VaultSessionEntry | null {
  const sessionId = asString(row.id);
  if (!sessionId) {
    return null; // unusable row (D8)
  }
  const title = asString(row.title) ?? asString(row.first_user_message) ?? "";
  return {
    id: `codex:${sessionId}`,
    agent: "codex",
    sessionId,
    title: boundedPreview(title),
    cwd: asString(row.cwd) ?? "",
    modified: Number(row.updated_at_ms) || 0,
    flags: {
      model: asString(row.model),
      approval: asString(row.approval_mode),
      sandbox: parseSandbox(row.sandbox_policy),
      reasoningEffort: asString(row.reasoning_effort),
    },
    canFork: false, // resolved by VaultService (task 2_5)
  };
}

async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...(await walkJsonl(full)));
    } else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

async function readFirstLine(filePath: string): Promise<string | undefined> {
  let stream: ReturnType<typeof createReadStream> | undefined;
  let rl: readline.Interface | undefined;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
    rl = readline.createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      return line;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    rl?.close();
    stream?.destroy();
  }
}

/** Degraded source: minimal entries from session_meta first lines. */
async function readCodexJsonlFallback(sessionsDir: string): Promise<ReaderResult> {
  const files = await walkJsonl(sessionsDir);
  const entries: VaultSessionEntry[] = [];
  let unreadable = 0;

  for (const filePath of files) {
    try {
      const first = await readFirstLine(filePath);
      if (!first) {
        unreadable++;
        continue;
      }
      const obj = JSON.parse(first) as { payload?: { id?: unknown; cwd?: unknown } };
      const payload = obj.payload ?? {};
      const sessionId = asString(payload.id) ?? path.basename(filePath, ".jsonl");
      const stat = await fs.stat(filePath);
      entries.push({
        id: `codex:${sessionId}`,
        agent: "codex",
        sessionId,
        title: "",
        cwd: asString(payload.cwd) ?? "",
        modified: stat.mtimeMs,
        flags: {},
        canFork: false,
      });
    } catch {
      unreadable++;
    }
  }
  entries.sort((a, b) => b.modified - a.modified);
  return { entries, unreadable };
}

export async function readCodexSessions(options: CodexReaderOptions = {}): Promise<ReaderResult> {
  const home = options.home ?? os.homedir();
  const codexDir = options.codexDir ?? path.join(home, ".codex");
  const dbPath = path.join(codexDir, "state_5.sqlite");
  const sessionsDir = path.join(codexDir, "sessions");
  const readSqliteFn = options.readSqliteFn ?? readSqlite;

  const result = await readSqliteFn(dbPath, CODEX_THREADS_SQL);

  if (result.status === "no-db" || result.status === "no-sqlite3") {
    return readCodexJsonlFallback(sessionsDir);
  }
  if (result.status === "query-error") {
    // Surface, don't mask with the fallback (spec: query-error → unreadable).
    return { entries: [], unreadable: 1 };
  }

  // status === "ok"
  const entries: VaultSessionEntry[] = [];
  let unreadable = 0;
  for (const row of result.rows) {
    const entry = mapThreadRow(row);
    if (entry) {
      entries.push(entry);
    } else {
      unreadable++;
    }
  }
  return { entries, unreadable };
}
