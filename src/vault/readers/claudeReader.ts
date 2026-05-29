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
import { formatEntryId, type VaultSessionDetail, type VaultSessionEntry } from "../types";
import {
  type ClaudeChildStub,
  classifyClaudeStyleEvents,
  cleanPromptText,
  createBoundedRecordBuffer,
  finalizeDetail,
} from "./detail";

/** Separates a parent session id from a subagent file stem in an entry id:
 *  `claude:<parentSessionId>:subagent:<agent-stem>`. */
const SUBAGENT_MARKER = ":subagent:";

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
async function readLatestAiTitle(filePath: string): Promise<string | undefined> {
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

function extractUserText(message: unknown): string | undefined {
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
      if (!haveUser && obj.type === "user" && obj.isMeta !== true && obj.isSidechain !== true) {
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

/** Resolve the store root + projects dir (shared by list + detail paths). */
function claudeRoots(options: ClaudeReaderOptions): { configDir?: string; projectsDir: string } {
  const configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const home = options.home ?? os.homedir();
  const root = configDir ? configDir : path.join(home, ".claude");
  return { configDir, projectsDir: path.join(root, "projects") };
}

/** Session ids are filename stems — reject anything that could escape the dir. */
function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

/**
 * Locate the unique session file by id with a metadata-only directory scan
 * (each `<projects>/<dir>/<sessionId>.jsonl`) — no transcript content is read.
 * The candidate is containment-checked under the projects dir before being
 * returned, and the host never trusts a webview-supplied path (D3).
 */
export async function resolveClaudeSessionPath(
  sessionId: string,
  options: ClaudeReaderOptions = {},
): Promise<string | null> {
  if (!isSafeSessionId(sessionId)) {
    return null;
  }
  const { projectsDir } = claudeRoots(options);
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    const rel = path.relative(projectsDir, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue; // outside the store root — never read it
    }
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // not in this project dir — keep scanning
    }
  }
  return null;
}

/**
 * Read parseable records from a session jsonl (skip-malformed, D8), bounded to a
 * head + tail window so a tens-of-MB transcript never fully materializes (W1).
 * Returns `truncated` when the middle was dropped.
 */
async function streamClaudeRecords(
  filePath: string,
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
          buffer.push(parsed as Record<string, unknown>);
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

/**
 * On-demand bounded detail for a Claude session: resolve the file by id, stream
 * + classify its mixed-event records. Returns null when the session can't be
 * located or read.
 */
export async function readClaudeDetail(
  sessionId: string,
  options: ClaudeReaderOptions = {},
  limit?: number,
): Promise<VaultSessionDetail | null> {
  // Subagent fetch: `<parentSessionId>:subagent:<stem>` resolves a transcript in
  // the parent's `subagents/` dir. Its records are all `isSidechain` (that IS the
  // conversation here), so classify with `includeSidechain`.
  const markerAt = sessionId.indexOf(SUBAGENT_MARKER);
  if (markerAt >= 0) {
    const parentId = sessionId.slice(0, markerAt);
    const stem = sessionId.slice(markerAt + SUBAGENT_MARKER.length);
    const filePath = await resolveClaudeSubagentPath(parentId, stem, options);
    if (!filePath) {
      return null;
    }
    const read = await streamClaudeRecords(filePath);
    if (read === null) {
      return null;
    }
    const detail = classifyClaudeStyleEvents(read.records, { limit, includeSidechain: true });
    return finalizeDetail(formatEntryId("claude", sessionId), detail, read.truncated);
  }

  const filePath = await resolveClaudeSessionPath(sessionId, options);
  if (!filePath) {
    return null;
  }
  const read = await streamClaudeRecords(filePath);
  if (read === null) {
    return null;
  }
  const childStubs = await listClaudeSubagentStubs(sessionId, options);
  const detail = classifyClaudeStyleEvents(read.records, { limit, childStubs });
  return finalizeDetail(formatEntryId("claude", sessionId), detail, read.truncated);
}

/**
 * Resolve a subagent transcript at `<projects>/<dir>/<parentId>/subagents/<stem>.jsonl`.
 * Both id parts are filename-safe (no traversal) and the resolved path is
 * containment-checked under the projects dir — the host never trusts the
 * webview-supplied composite id (D3).
 */
export async function resolveClaudeSubagentPath(
  parentId: string,
  stem: string,
  options: ClaudeReaderOptions = {},
): Promise<string | null> {
  if (!isSafeSessionId(parentId) || !isSafeSessionId(stem)) {
    return null;
  }
  const { projectsDir } = claudeRoots(options);
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = path.join(projectsDir, dir, parentId, "subagents", `${stem}.jsonl`);
    const rel = path.relative(projectsDir, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // not under this project dir — keep scanning
    }
  }
  return null;
}

/**
 * Discover a parent session's subagents: `<projects>/<dir>/<parentId>/subagents/`
 * holds `<stem>.jsonl` transcripts + `<stem>.meta.json` (`{agentType, description}`).
 * Returns a lazy stub per subagent (entryId + meta + first prompt) — fail-safe to
 * `[]` (a missing dir / unreadable meta just yields no nesting).
 */
async function listClaudeSubagentStubs(parentId: string, options: ClaudeReaderOptions): Promise<ClaudeChildStub[]> {
  if (!isSafeSessionId(parentId)) {
    return [];
  }
  const { projectsDir } = claudeRoots(options);
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  for (const dir of projectDirs) {
    const subagentsDir = path.join(projectsDir, dir, parentId, "subagents");
    const rel = path.relative(projectsDir, subagentsDir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    let files: string[];
    try {
      files = await fs.readdir(subagentsDir);
    } catch {
      continue; // no subagents dir under this project — try the next
    }
    const stems = files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
    const stubs: ClaudeChildStub[] = [];
    for (const stem of stems) {
      if (!isSafeSessionId(stem)) {
        continue;
      }
      const meta = await readSubagentMeta(path.join(subagentsDir, `${stem}.meta.json`));
      const first = await readFirstUserRecord(path.join(subagentsDir, `${stem}.jsonl`));
      stubs.push({
        entryId: formatEntryId("claude", `${parentId}${SUBAGENT_MARKER}${stem}`),
        agentType: meta?.agentType,
        description: meta?.description,
        firstMessage: first?.text,
        timestamp: first?.timestamp,
      });
    }
    return stubs;
  }
  return [];
}

/** Read a subagent's `{agentType, description}` meta sidecar (best-effort). */
async function readSubagentMeta(metaPath: string): Promise<{ agentType?: string; description?: string } | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      return null;
    }
    return {
      agentType: typeof obj.agentType === "string" ? obj.agentType : undefined,
      description: typeof obj.description === "string" ? obj.description : undefined,
    };
  } catch {
    return null;
  }
}

/** Cheaply read a transcript's first user message text + timestamp (head only). */
async function readFirstUserRecord(filePath: string): Promise<{ text: string; timestamp: number } | null> {
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

/**
 * Build one Claude entry from its session file (metadata + first/last record).
 * Shared by the list scan and the single-entry resolve so both produce identical
 * entries. Throws on stat/read failure (caller catches → unreadable); returns
 * null when the file has no usable records (D8). The cwd falls back to the decoded
 * project-dir name (the file's parent) when the transcript omits it.
 */
async function buildClaudeEntry(
  filePath: string,
  sessionId: string,
  configDir: string | undefined,
): Promise<VaultSessionEntry | null> {
  const stat = await fs.stat(filePath);
  const fields = await parseClaudeFile(filePath);
  if (!fields) {
    return null;
  }
  // Prefer Claude's own regenerated title; fall back to the first prompt.
  const aiTitle = await readLatestAiTitle(filePath);
  return {
    id: formatEntryId("claude", sessionId),
    agent: "claude",
    sessionId,
    title: boundedPreview(aiTitle ?? fields.title ?? ""),
    cwd: fields.cwd ?? decodeProjectDir(path.basename(path.dirname(filePath))),
    modified: stat.mtimeMs,
    flags: {
      model: fields.model,
      permissionMode: fields.permissionMode,
      configDir,
    },
    canFork: false, // resolved by VaultService (task 2_5)
    // File-backed → the webview shows file-targeting context-menu items;
    // the host re-derives this path by id, never trusting it (D9).
    sessionPath: filePath,
  };
}

export async function readClaudeSessions(options: ClaudeReaderOptions = {}): Promise<ReaderResult> {
  const { configDir, projectsDir } = claudeRoots(options);

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
        const entry = await buildClaudeEntry(filePath, sessionId, configDir);
        if (entry) {
          entries.push(entry);
        } else {
          unreadable++;
        }
      } catch {
        unreadable++;
      }
    }
  }

  return { entries, unreadable };
}

/**
 * Resolve ONE Claude session to its launch entry by id — the single-entry
 * counterpart to readClaudeSessions, used by VaultService.getEntry for fast
 * resume/fork (no full-store scan; D3). Locates the file via the same
 * containment-checked, metadata-only path resolver. Returns null for an unsafe
 * id or an unlocatable/unparseable session.
 */
export async function readClaudeEntry(
  sessionId: string,
  options: ClaudeReaderOptions = {},
): Promise<VaultSessionEntry | null> {
  const { configDir } = claudeRoots(options);
  const filePath = await resolveClaudeSessionPath(sessionId, options);
  if (!filePath) {
    return null;
  }
  try {
    return await buildClaudeEntry(filePath, sessionId, configDir);
  } catch {
    return null;
  }
}
