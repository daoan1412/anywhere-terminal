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
import {
  formatEntryId,
  type VaultActivityStep,
  type VaultSessionDetail,
  type VaultSessionEntry,
  type VaultTimelineItem,
} from "../types";
import type { ReaderResult } from "./claudeReader";
import {
  boundActivity,
  boundTimeline,
  createBoundedRecordBuffer,
  finalizeDetail,
  MAX_MESSAGE_TEXT,
  truncate,
} from "./detail";

/** Bound the SQLite read so the vault list stays cheap (D2). */
const ROW_LIMIT = 500;

const CODEX_THREAD_COLUMNS = `id, rollout_path, cwd, title, model, git_branch,
       approval_mode, sandbox_policy, reasoning_effort,
       first_user_message, updated_at_ms`;

const CODEX_THREADS_SQL = `SELECT ${CODEX_THREAD_COLUMNS}
FROM threads
WHERE archived = 0
ORDER BY updated_at_ms DESC
LIMIT ${ROW_LIMIT}`;

/** Single-thread lookup for the single-entry resolve (readCodexEntry). `id` is
 *  validated by isSafeCodexId before this is called, so the embed is injection-safe. */
function codexThreadByIdSql(id: string): string {
  return `SELECT ${CODEX_THREAD_COLUMNS} FROM threads WHERE id = '${id}' LIMIT 1`;
}

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
    id: formatEntryId("codex", sessionId),
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
    // File-backed iff a rollout transcript exists (UI hint only, D9). The host
    // re-derives this path by id; it never trusts a webview-supplied path.
    sessionPath: asString(row.rollout_path),
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

/**
 * Build one minimal Codex entry from a rollout jsonl's `session_meta` first line.
 * Shared by the JSONL fallback list and the single-entry resolve. Throws on
 * read/parse failure (caller catches → unreadable); returns null when the first
 * line is empty. `sessionIdOverride` forces the resolved id on the by-id path so
 * the resume command targets the requested session even if `payload.id` is absent.
 */
async function buildCodexJsonlEntry(filePath: string, sessionIdOverride?: string): Promise<VaultSessionEntry | null> {
  const first = await readFirstLine(filePath);
  if (!first) {
    return null;
  }
  const obj = JSON.parse(first) as { payload?: { id?: unknown; cwd?: unknown } };
  const payload = obj.payload ?? {};
  const sessionId = sessionIdOverride ?? asString(payload.id) ?? path.basename(filePath, ".jsonl");
  const stat = await fs.stat(filePath);
  return {
    id: formatEntryId("codex", sessionId),
    agent: "codex",
    sessionId,
    title: "",
    cwd: asString(payload.cwd) ?? "",
    modified: stat.mtimeMs,
    flags: {},
    canFork: false,
    sessionPath: filePath, // the rollout jsonl backs this session (UI hint)
  };
}

/** Degraded source: minimal entries from session_meta first lines. */
async function readCodexJsonlFallback(sessionsDir: string): Promise<ReaderResult> {
  const files = await walkJsonl(sessionsDir);
  const entries: VaultSessionEntry[] = [];
  let unreadable = 0;

  for (const filePath of files) {
    try {
      const entry = await buildCodexJsonlEntry(filePath);
      if (entry) {
        entries.push(entry);
      } else {
        unreadable++;
      }
    } catch {
      unreadable++;
    }
  }
  entries.sort((a, b) => b.modified - a.modified);
  return { entries, unreadable };
}

/** Trim an env-var path; treat empty/whitespace as unset. */
function envDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve Codex's dirs. Codex resolves its home as `$CODEX_HOME` (when set) else
 * `~/.codex`; the default is correct on Windows too (`os.homedir()` =
 * `%USERPROFILE%`). The SQLite DB can be relocated independently via
 * `$CODEX_SQLITE_HOME`. See docs/research/20260529-cross-platform-store-paths-sqlite.md.
 */
function codexDirs(options: CodexReaderOptions): { dbPath: string; sessionsDir: string } {
  const home = options.home ?? os.homedir();
  const codexDir = options.codexDir ?? envDir(process.env.CODEX_HOME) ?? path.join(home, ".codex");
  const sqliteDir = envDir(process.env.CODEX_SQLITE_HOME) ?? codexDir;
  return { dbPath: path.join(sqliteDir, "state_5.sqlite"), sessionsDir: path.join(codexDir, "sessions") };
}

export async function readCodexSessions(options: CodexReaderOptions = {}): Promise<ReaderResult> {
  const { dbPath, sessionsDir } = codexDirs(options);
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

/**
 * Resolve ONE Codex session to its launch entry by id — the single-entry
 * counterpart to readCodexSessions, used by VaultService.getEntry for fast
 * resume/fork (a `threads` point lookup, not the full-store scan; D3). Falls back
 * to the rollout jsonl (located by its filename uuid) when no SQLite DB exists.
 * Returns null for an unsafe id or an unlocatable session.
 */
export async function readCodexEntry(
  sessionId: string,
  options: CodexReaderOptions = {},
): Promise<VaultSessionEntry | null> {
  if (!isSafeCodexId(sessionId)) {
    return null;
  }
  const { dbPath, sessionsDir } = codexDirs(options);
  const readSqliteFn = options.readSqliteFn ?? readSqlite;

  const result = await readSqliteFn(dbPath, codexThreadByIdSql(sessionId));
  if (result.status === "ok") {
    return result.rows.length > 0 ? mapThreadRow(result.rows[0]) : null;
  }
  if (result.status === "no-db" || result.status === "no-sqlite3") {
    const filePath = await findCodexRolloutByFilename(sessionId, sessionsDir);
    if (!filePath) {
      return null;
    }
    try {
      return await buildCodexJsonlEntry(filePath, sessionId);
    } catch {
      return null;
    }
  }
  return null; // query-error → unresolved (caller treats null as unknown-entry)
}

// ── On-demand session detail (redesign-vault-panel-ui 2_4) ──────────────────
//
// The Codex rollout JSONL is NOT Claude-shaped (build-time discovery, design
// D4): records are `{timestamp, type, payload}` with `type` ∈ session_meta /
// event_msg / response_item / turn_context. So this reader has its own
// classifier; when no rollout exists it degrades to a partial detail built from
// the `threads` index (`first_user_message`).

const PARTIAL_LIMITED_REASON = "No transcript file for this Codex session — showing index only.";

function objField(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseTs(v: unknown): number {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : 0;
  }
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

/** Session ids are uuids; reject anything that could escape a filename/SQL. */
function isSafeCodexId(id: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(id);
}

/** Primary arg for a Codex `function_call` (arguments is a JSON string). */
function codexFunctionLabel(args: unknown): string | undefined {
  const raw = asString(args);
  let obj: Record<string, unknown> | undefined;
  if (typeof args === "string") {
    try {
      obj = objField(JSON.parse(args));
    } catch {
      obj = undefined;
    }
  } else {
    obj = objField(args);
  }
  if (obj) {
    for (const k of ["cmd", "command", "file_path", "path", "query", "pattern"]) {
      const s = asString(obj[k]);
      if (s) {
        return s;
      }
    }
    for (const v of Object.values(obj)) {
      const s = asString(v);
      if (s) {
        return s;
      }
    }
  }
  return raw;
}

/** Best-effort reasoning text from a Codex `reasoning` item — only the plaintext
 *  `summary[].text` (the bulk is `encrypted_content`, which we never surface). */
function codexReasoningText(payload: Record<string, unknown>): string | undefined {
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    const parts: string[] = [];
    for (const s of summary) {
      const t = asString(objField(s)?.text);
      if (t) {
        parts.push(t);
      }
    }
    const joined = parts.join(" ").trim();
    if (joined) {
      return joined;
    }
  }
  return asString(payload.content);
}

/** Label an `apply_patch`-style custom tool: prefer the `*** … File: <p>` line, else first line. */
function codexPatchLabel(input: unknown): string | undefined {
  const text = asString(input);
  if (!text) {
    return undefined;
  }
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/\*\*\* (?:Add|Update|Delete) File:\s*(.+)/);
    if (m) {
      return m[1].trim();
    }
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) {
      return t;
    }
  }
  return undefined;
}

/**
 * Dedicated classifier for the Codex rollout schema → bounded session detail
 * (same `VaultSessionDetail` shape as Claude/OpenCode, so D5/D6 bounds hold).
 */
export function classifyCodexRolloutEvents(
  records: Record<string, unknown>[],
  limit?: number,
): Omit<VaultSessionDetail, "entryId"> {
  let firstPrompt: string | undefined;
  let latestMessage: VaultSessionDetail["latestMessage"];
  const activity: VaultActivityStep[] = [];
  const timeline: VaultTimelineItem[] = [];
  let messageCount = 0;
  let toolCount = 0;
  let totalTokens: number | undefined;

  for (const rec of records) {
    if (!rec || typeof rec !== "object") {
      continue;
    }
    const payload = objField(rec.payload);
    if (!payload) {
      continue;
    }
    const type = rec.type;
    const ptype = payload.type;
    const ts = parseTs(rec.timestamp);

    if (type === "event_msg") {
      if (ptype === "user_message") {
        const m = asString(payload.message);
        if (m) {
          messageCount++;
          if (firstPrompt === undefined) {
            firstPrompt = truncate(m);
          }
          latestMessage = { role: "user", text: truncate(m), timestamp: ts };
          timeline.push({ kind: "message", role: "user", text: truncate(m, MAX_MESSAGE_TEXT), timestamp: ts });
        }
      } else if (ptype === "agent_message") {
        const m = asString(payload.message);
        if (m) {
          messageCount++;
          latestMessage = { role: "assistant", text: truncate(m), timestamp: ts };
          timeline.push({ kind: "message", role: "assistant", text: truncate(m, MAX_MESSAGE_TEXT), timestamp: ts });
        }
      } else if (ptype === "token_count") {
        const tot = objField(objField(payload.info)?.total_token_usage);
        const n = tot ? num(tot.total_tokens) : 0;
        if (n > 0) {
          totalTokens = n; // last token_count is the cumulative session total (D7)
        }
      }
    } else if (type === "response_item") {
      if (ptype === "function_call") {
        toolCount++;
        const name = asString(payload.name) ?? "tool";
        const label = codexFunctionLabel(payload.arguments);
        const step: VaultActivityStep = { kind: "tool", tool: name, detail: label ? truncate(label) : undefined };
        activity.push(step);
        timeline.push(step);
      } else if (ptype === "custom_tool_call") {
        toolCount++;
        const name = asString(payload.name) ?? "tool";
        const label = codexPatchLabel(payload.input);
        const step: VaultActivityStep = { kind: "tool", tool: name, detail: label ? truncate(label) : undefined };
        activity.push(step);
        timeline.push(step);
      } else if (ptype === "web_search_call") {
        toolCount++;
        const q = asString(objField(payload.action)?.query);
        const step: VaultActivityStep = { kind: "tool", tool: "WebSearch", detail: q ? truncate(q) : undefined };
        activity.push(step);
        timeline.push(step);
      } else if (ptype === "reasoning") {
        const t = codexReasoningText(payload);
        if (t) {
          timeline.push({ kind: "thinking", text: truncate(t, MAX_MESSAGE_TEXT), timestamp: ts });
        }
      }
      // function_call_output / custom_tool_call_output / reasoning / message → skipped
    }
  }

  const bounded = boundTimeline(timeline, limit);
  return {
    firstPrompt,
    recentActivity: boundActivity(activity),
    latestMessage,
    timeline: bounded.timeline,
    ...(bounded.truncated ? { truncated: true } : {}),
    stats: {
      messageCount,
      toolCount,
      subagentCount: 0,
      ...(totalTokens !== undefined ? { tokenCount: totalTokens } : {}),
    },
  };
}

/**
 * Read parseable records from a rollout jsonl (skip-malformed, D8), bounded to a
 * head + tail window so a large rollout never fully materializes (W1). Returns
 * `truncated` when the middle was dropped.
 */
async function streamCodexRecords(
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
        // skip a corrupt line, keep reading (D8)
      }
    }
  } catch {
    return null;
  } finally {
    rl?.close();
    stream?.destroy();
  }
  return buffer.result();
}

/** True iff `p` resolves inside `root`. */
function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Find the rollout jsonl by the session uuid embedded in its filename. */
async function findCodexRolloutByFilename(sessionId: string, sessionsDir: string): Promise<string | null> {
  const suffix = `-${sessionId}.jsonl`;
  let dirents: import("node:fs").Dirent[];
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      break;
    }
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile() && dirent.name.endsWith(suffix)) {
        return full;
      }
    }
  }
  return null;
}

/** Best-effort: the `threads` index row for one session (rollout_path + first prompt). */
async function queryCodexThread(
  sessionId: string,
  dbPath: string,
  readSqliteFn: typeof readSqlite,
): Promise<{ rolloutPath?: string; firstUserMessage?: string } | null> {
  const sql = `SELECT rollout_path, first_user_message FROM threads WHERE id = '${sessionId}' LIMIT 1`;
  const res = await readSqliteFn(dbPath, sql);
  if (res.status !== "ok" || res.rows.length === 0) {
    return null;
  }
  const row = res.rows[0];
  return { rolloutPath: asString(row.rollout_path), firstUserMessage: asString(row.first_user_message) };
}

/**
 * On-demand detail for a Codex session: classify the rollout jsonl when one can
 * be located (full detail); otherwise return a labeled partial detail from the
 * `threads` index. Returns null when the session can't be located at all.
 */
export async function readCodexDetail(
  sessionId: string,
  options: CodexReaderOptions = {},
  limit?: number,
): Promise<VaultSessionDetail | null> {
  if (!isSafeCodexId(sessionId)) {
    return null;
  }
  const { dbPath, sessionsDir } = codexDirs(options);
  const readSqliteFn = options.readSqliteFn ?? readSqlite;

  const thread = await queryCodexThread(sessionId, dbPath, readSqliteFn);

  // Prefer the index's rollout_path (containment-checked); else scan by filename.
  let rolloutPath = thread?.rolloutPath && isUnder(thread.rolloutPath, sessionsDir) ? thread.rolloutPath : undefined;
  if (!rolloutPath) {
    rolloutPath = (await findCodexRolloutByFilename(sessionId, sessionsDir)) ?? undefined;
  }

  if (rolloutPath) {
    const read = await streamCodexRecords(rolloutPath);
    if (read && read.records.length > 0) {
      const detail = classifyCodexRolloutEvents(read.records, limit);
      return finalizeDetail(formatEntryId("codex", sessionId), detail, read.truncated);
    }
  }

  if (thread?.firstUserMessage) {
    return {
      entryId: formatEntryId("codex", sessionId),
      firstPrompt: truncate(thread.firstUserMessage),
      recentActivity: [],
      latestMessage: { role: "user", text: truncate(thread.firstUserMessage), timestamp: 0 },
      timeline: [
        { kind: "message", role: "user", text: truncate(thread.firstUserMessage, MAX_MESSAGE_TEXT), timestamp: 0 },
      ],
      // The index-only fallback surfaces exactly the one indexed prompt (s3 — was 0).
      stats: { messageCount: 1, toolCount: 0, subagentCount: 0 },
      partial: true,
      limitedReason: PARTIAL_LIMITED_REASON,
    };
  }

  return null;
}
