// src/vault/readers/claudeReader.ts — Read Claude Code sessions (metadata only).
// See: specs/agent-session-index/spec.md (Read Claude Code sessions; Metadata-only),
//      design.md D4 (bounded title preview), D7 (cwd encoding), D8 (defensive parse),
//      docs/research/20260528-cmux-vault-mechanism.md §3.
//
// Sessions live at `<root>/projects/<encoded-cwd>/*.jsonl` where root is
// `$CLAUDE_CONFIG_DIR` else `~/.claude`, and the encoded-cwd dir name is the
// project cwd with every `/` replaced by `-`. We stream each file and stop once
// the title (first user message) and model (first assistant message) are found —
// the full transcript is never loaded.

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { boundedPreview } from "../preview";
import type { VaultSessionEntry } from "../types";

export interface ClaudeReaderOptions {
  /** `$CLAUDE_CONFIG_DIR` override; defaults to the env var. */
  configDir?: string;
  /** Home dir; defaults to `os.homedir()`. */
  home?: string;
}

export interface ReaderResult {
  entries: VaultSessionEntry[];
  unreadable: number;
}

interface ClaudeFileFields {
  cwd?: string;
  gitBranch?: string;
  permissionMode?: string;
  model?: string;
  title?: string;
  /** True when at least one line parsed as JSON — otherwise the file is junk. */
  parsedAnyLine: boolean;
}

function extractUserText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(" ")
      .trim();
    return text || undefined;
  }
  return undefined;
}

async function parseClaudeFile(filePath: string): Promise<ClaudeFileFields | null> {
  const fields: ClaudeFileFields = { parsedAnyLine: false };
  let summary: string | undefined;
  let haveUser = false;
  let haveAssistant = false;

  let stream: ReturnType<typeof createReadStream> | undefined;
  let rl: readline.Interface | undefined;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
    rl = readline.createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let obj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null) {
          continue;
        }
        obj = parsed as Record<string, unknown>;
      } catch {
        continue; // skip a single corrupt line, keep reading (D8)
      }
      fields.parsedAnyLine = true;

      if (fields.cwd === undefined && typeof obj.cwd === "string") {
        fields.cwd = obj.cwd;
      }
      if (fields.gitBranch === undefined && typeof obj.gitBranch === "string") {
        fields.gitBranch = obj.gitBranch;
      }
      if (fields.permissionMode === undefined && typeof obj.permissionMode === "string") {
        fields.permissionMode = obj.permissionMode;
      }
      if (summary === undefined && obj.type === "summary" && typeof obj.summary === "string") {
        summary = obj.summary;
      }
      if (!haveUser && obj.type === "user") {
        const text = extractUserText(obj.message);
        if (text) {
          fields.title = text;
          haveUser = true;
        }
      }
      if (!haveAssistant && obj.type === "assistant") {
        const model = (obj.message as { model?: unknown } | undefined)?.model;
        if (typeof model === "string") {
          fields.model = model;
          haveAssistant = true;
        }
      }
      // Title + model are the last-appearing fields we need; cwd/branch/mode
      // sit on earlier lines, so stop here to avoid loading the transcript.
      if (haveUser && haveAssistant) {
        break;
      }
    }
  } catch {
    return null; // stream/open failure → unreadable
  } finally {
    rl?.close();
    stream?.destroy();
  }

  if (!fields.parsedAnyLine) {
    return null;
  }
  if (fields.title === undefined && summary !== undefined) {
    fields.title = summary;
  }
  return fields;
}

/** Decode an encoded project dir back to a cwd (lossy, fallback only — D7). */
function decodeProjectDir(dirName: string): string {
  return dirName.replace(/-/g, "/");
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

export async function readClaudeSessions(options: ClaudeReaderOptions = {}): Promise<ReaderResult> {
  const configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const home = options.home ?? os.homedir();
  const root = configDir ? configDir : path.join(home, ".claude");
  const projectsDir = path.join(root, "projects");

  let projectDirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { entries: [], unreadable: 0 }; // no store → zero entries, not an error
  }

  const entries: VaultSessionEntry[] = [];
  let unreadable = 0;

  for (const projectDir of projectDirs) {
    const dirPath = path.join(projectsDir, projectDir);
    const files = await listJsonlFiles(dirPath);
    for (const filePath of files) {
      const sessionId = path.basename(filePath, ".jsonl");
      try {
        const stat = await fs.stat(filePath);
        const fields = await parseClaudeFile(filePath);
        if (!fields) {
          unreadable++;
          continue;
        }
        entries.push({
          id: `claude:${sessionId}`,
          agent: "claude",
          sessionId,
          title: boundedPreview(fields.title ?? ""),
          cwd: fields.cwd ?? decodeProjectDir(projectDir),
          modified: stat.mtimeMs,
          flags: {
            model: fields.model,
            permissionMode: fields.permissionMode,
            configDir,
          },
          canFork: false, // resolved by VaultService (task 2_5)
        });
      } catch {
        unreadable++;
      }
    }
  }

  return { entries, unreadable };
}
