// src/vault/readers/opencodeReader.ts — Read OpenCode sessions (SQLite only).
// See: specs/agent-session-index/spec.md (Read OpenCode sessions), design.md D3,D8,
//      docs/research/20260528-cmux-vault-mechanism.md §7.
//
// Source is the `session` table of ~/.local/share/opencode/opencode.db, with a
// correlated subquery for the latest assistant `message` to recover the model +
// agent. OpenCode has no JSONL fallback: an absent DB contributes zero entries.

import * as os from "node:os";
import * as path from "node:path";
import type { ReaderListCache, ReaderResultWithState } from "../cacheTypes";
import { boundedPreview } from "../preview";
import { readSqlite } from "../sqlite";
import { sameStamps, stampStoreFiles } from "../storeStamp";
import {
  formatEntryId,
  type VaultActivityStep,
  type VaultSessionDetail,
  type VaultSessionEntry,
  type VaultTimelineItem,
} from "../types";
import { boundActivity, boundTimeline, MAX_MESSAGE_TEXT, truncate, truncateRich } from "./detail";

/** Bound the read so the vault list stays cheap (D2). */
const ROW_LIMIT = 500;

/** Bound the per-session detail read (one conversation, ample headroom). */
const DETAIL_MESSAGE_LIMIT = 2000;
const DETAIL_PART_LIMIT = 5000;
/** Bound the direct-child stubs embedded in a parent's detail timeline. */
const CHILD_LIMIT = 100;

// Shared SELECT (columns + correlated title/first-prompt subqueries). The list
// adds the top-level `parent_id` filter + ordering/limit; the single-entry resolve
// (readOpenCodeEntry) adds `WHERE s.id = ?` and keeps no filter so a child session
// is still resolvable by id for resume.
const OPENCODE_SESSION_SELECT = `SELECT s.id, s.title, s.directory, s.time_updated, (
    SELECT data FROM message
    WHERE session_id = s.id AND data LIKE '%"role":"assistant"%'
    ORDER BY time_created DESC LIMIT 1
) AS last_assistant, (
    SELECT p.data FROM part p JOIN message m ON p.message_id = m.id
    WHERE p.session_id = s.id AND m.data LIKE '%"role":"user"%'
      AND p.data LIKE '%"type":"text"%' AND p.data NOT LIKE '%"synthetic":true%'
    ORDER BY p.time_created ASC LIMIT 1
) AS first_user_part
FROM session s`;

const OPENCODE_SESSION_SQL = `${OPENCODE_SESSION_SELECT}
WHERE s.parent_id IS NULL OR s.parent_id = ''
ORDER BY s.time_updated DESC
LIMIT ${ROW_LIMIT}`;

export interface OpenCodeReaderOptions {
  home?: string;
  /** Override `~/.local/share/opencode`. */
  dataDir?: string;
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

/** Recover model (provider/model) + agent from the latest assistant message JSON. */
function parseAssistant(raw: unknown): { model?: string; agent?: string } {
  if (typeof raw !== "string" || !raw) {
    return {};
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      return {};
    }
    const providerID = asString(obj.providerID);
    const modelID = asString(obj.modelID);
    const agent = asString(obj.agent);
    const model = providerID && modelID ? `${providerID}/${modelID}` : (modelID ?? providerID);
    return { model, agent };
  } catch {
    return {}; // malformed assistant JSON → no model/agent, entry still listed (D8)
  }
}

/** OpenCode's default title before it summarizes is `New session - <ISO ts>`.
 *  Treat that (and an empty title) as "no title" so we fall back to the prompt. */
function isPlaceholderTitle(title: string): boolean {
  return /^New session\b/i.test(title.trim());
}

/** First user message text from the `first_user_part` subquery (a text part). */
function firstUserPartText(raw: unknown): string | undefined {
  return strField(parseJsonData(raw)?.text);
}

function mapSessionRow(row: Record<string, unknown>): VaultSessionEntry | null {
  const sessionId = asString(row.id);
  if (!sessionId) {
    return null;
  }
  const { model, agent } = parseAssistant(row.last_assistant);
  // Prefer the session's real title; fall back to the first user message when
  // the title is absent or OpenCode's placeholder (#5).
  const rawTitle = asString(row.title);
  const title =
    rawTitle && !isPlaceholderTitle(rawTitle) ? rawTitle : (firstUserPartText(row.first_user_part) ?? rawTitle ?? "");
  return {
    id: formatEntryId("opencode", sessionId),
    agent: "opencode",
    sessionId,
    title: boundedPreview(title),
    cwd: asString(row.directory) ?? "",
    modified: Number(row.time_updated) || 0,
    flags: { model, agent },
    canFork: false, // resolved by VaultService (task 2_5)
  };
}

/** Resolve the opencode db path + sqlite reader, shared by the list and single-entry paths. */
function resolveOpencodePaths(options: OpenCodeReaderOptions): {
  dbPath: string;
  readSqliteFn: typeof readSqlite;
} {
  const home = options.home ?? os.homedir();
  // OpenCode resolves its data dir via the `xdg-basedir` package, which is the
  // SAME on every OS (it is NOT OS-aware): `$XDG_DATA_HOME/opencode` else
  // `~/.local/share/opencode` — including Windows (`%USERPROFILE%\.local\share`,
  // NOT %APPDATA%). Mirror that here. See docs/research/20260529-cross-platform-store-paths-sqlite.md.
  const xdgData = process.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const dataDir = options.dataDir ?? path.join(xdgData, "opencode");
  return { dbPath: path.join(dataDir, "opencode.db"), readSqliteFn: options.readSqliteFn ?? readSqlite };
}

export async function readOpenCodeSessions(
  options: OpenCodeReaderOptions = {},
  prev?: ReaderListCache,
): Promise<ReaderResultWithState> {
  const { dbPath, readSqliteFn } = resolveOpencodePaths(options);

  // Skip the snapshot clone + query when the DB (+ -wal) is unchanged since the
  // cache was written (cache-vault-load D3). Guarded on a non-empty stamp set so
  // an absent DB falls through to the query (→ zero entries) rather than reusing {}.
  const sources = await stampStoreFiles([dbPath, `${dbPath}-wal`]);
  if (prev?.kind === "store" && Object.keys(sources).length > 0 && sameStamps(prev.sources, sources)) {
    const u = prev.unreadable ?? 0;
    return {
      entries: prev.entries,
      unreadable: u,
      cache: { kind: "store", sources, entries: prev.entries, unreadable: u },
    };
  }

  const result = await readSqliteFn(dbPath, OPENCODE_SESSION_SQL);

  if (result.status === "query-error") {
    // Cache EMPTY sources so a query-error is retried next refresh, not reused as
    // an empty success (oracle review).
    return { entries: [], unreadable: 1, cache: { kind: "store", sources: {}, entries: [], unreadable: 1 } };
  }
  if (result.status !== "ok") {
    // no-db / no-sqlite3 → zero entries; empty sources so the next refresh re-reads.
    return { entries: [], unreadable: 0, cache: { kind: "store", sources: {}, entries: [], unreadable: 0 } };
  }

  const entries: VaultSessionEntry[] = [];
  let unreadable = 0;
  for (const row of result.rows) {
    const entry = mapSessionRow(row);
    if (entry) {
      entries.push(entry);
    } else {
      unreadable++;
    }
  }
  return { entries, unreadable, cache: { kind: "store", sources, entries, unreadable } };
}

/**
 * Resolve ONE OpenCode session to its launch entry by id — the single-entry
 * counterpart to readOpenCodeSessions, used by VaultService.getEntry for fast
 * resume/fork (a point lookup, not the full-store scan; D3). No `parent_id`
 * filter so a child (subagent) session is still resolvable by id. Returns null
 * for an unsafe id or a missing row.
 */
export async function readOpenCodeEntry(
  sessionId: string,
  options: OpenCodeReaderOptions = {},
): Promise<VaultSessionEntry | null> {
  if (!isSafeOpenCodeId(sessionId)) {
    return null;
  }
  const { dbPath, readSqliteFn } = resolveOpencodePaths(options);
  // `sessionId` is validated to `[A-Za-z0-9_-]+` above, so embedding it is safe.
  const result = await readSqliteFn(dbPath, `${OPENCODE_SESSION_SELECT} WHERE s.id = '${sessionId}' LIMIT 1`);
  if (result.status !== "ok" || result.rows.length === 0) {
    return null;
  }
  return mapSessionRow(result.rows[0]);
}

// ── On-demand session detail (redesign-vault-panel-ui 2_3) ──────────────────

/** A parsed `message` row for the pure mapper. */
export interface OcMessageRow {
  id: string;
  timeCreated: number;
  data: Record<string, unknown>;
}
/** A parsed `part` row for the pure mapper. */
export interface OcPartRow {
  messageId: string;
  timeCreated: number;
  data: Record<string, unknown>;
}

/** OpenCode session ids are `ses_<base62>` — validated before any SQL embed. */
function isSafeOpenCodeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function strField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function objField(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Concise primary argument for an OpenCode tool call (lowercase tool names, `filePath` inputs). */
function opencodeToolLabel(tool: string, input: Record<string, unknown>): string | undefined {
  switch (tool) {
    case "read":
    case "edit":
    case "write":
      return strField(input.filePath) ?? strField(input.file_path);
    case "bash":
      return strField(input.command);
    case "grep":
    case "glob":
      return strField(input.pattern);
    case "webfetch":
      return strField(input.url);
    default: {
      for (const v of Object.values(input)) {
        const s = strField(v);
        if (s) {
          return s;
        }
      }
      return undefined;
    }
  }
}

/** Count added/removed lines from a unified-diff string (cheap, best-effort). */
function diffStat(metadata: unknown): { added: number; removed: number } | undefined {
  const d = objField(metadata)?.diff;
  if (typeof d !== "string") {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  for (const line of d.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

/** A message is synthetic/compaction when flagged as a summary. */
function isSyntheticMessage(data: Record<string, unknown>): boolean {
  return data.summary === true;
}

/** Capitalize a lowercase tool name for display ("read" → "Read"). */
function titleCase(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * Pure: reconstruct bounded session detail from OpenCode `message` + `part`
 * rows (redesign-vault-panel-ui D4/D6). Tool/subtask are first-class parts;
 * synthetic/compaction messages are excluded from first/latest selection.
 */
export function mapOpencodeRows(
  messages: OcMessageRow[],
  parts: OcPartRow[],
  limit?: number,
  childStubs: { timestamp: number; item: VaultTimelineItem }[] = [],
): Omit<VaultSessionDetail, "entryId"> {
  const msgs = [...messages].sort((a, b) => a.timeCreated - b.timeCreated);
  const ordered = [...parts].sort((a, b) => a.timeCreated - b.timeCreated);

  // Text per message, ignoring synthetic text parts.
  const textByMessage = new Map<string, string[]>();
  for (const p of ordered) {
    if (p.data.type === "text" && p.data.synthetic !== true) {
      const t = strField(p.data.text);
      if (t) {
        const list = textByMessage.get(p.messageId) ?? [];
        list.push(t);
        textByMessage.set(p.messageId, list);
      }
    }
  }

  let firstPrompt: string | undefined;
  let latestMessage: VaultSessionDetail["latestMessage"];
  let messageCount = 0;
  let tokenCount = 0;
  let sawTokens = false;
  // Timeline items carry their source timestamp so messages + tool/subtask parts
  // can be merged into one chronological stream below.
  const tl: { ts: number; item: VaultTimelineItem }[] = [];

  for (const m of msgs) {
    if (isSyntheticMessage(m.data)) {
      continue;
    }
    // Skip malformed / unknown-role rows so they don't inflate the count (W7).
    const role = m.data.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (role === "assistant") {
      // A real assistant turn counts even when it's tool-only (no text), mirroring
      // the Claude classifier; tokens accrue regardless of visible text.
      messageCount++;
      const tokens = objField(m.data.tokens);
      if (tokens) {
        sawTokens = true;
        const cache = objField(tokens.cache) ?? {};
        tokenCount +=
          num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(cache.read) + num(cache.write);
      }
    }
    const text = (textByMessage.get(m.id) ?? []).join(" ").trim();
    if (text) {
      if (role === "user") {
        // A user row counts only when it carries real text (a tool-result-only
        // user row is plumbing, not a turn) (W7).
        messageCount++;
        if (firstPrompt === undefined) {
          firstPrompt = truncate(text);
        }
      }
      latestMessage = { role, text: truncate(text), timestamp: m.timeCreated };
      tl.push({
        ts: m.timeCreated,
        item: { kind: "message", role, text: truncateRich(text, MAX_MESSAGE_TEXT), timestamp: m.timeCreated },
      });
    }
  }

  const activity: VaultActivityStep[] = [];
  let toolCount = 0;
  let subagentCount = 0;
  for (const p of ordered) {
    const type = p.data.type;
    if (type === "tool") {
      toolCount++;
      const tool = strField(p.data.tool) ?? "tool";
      const state = objField(p.data.state) ?? {};
      const input = objField(state.input) ?? {};
      const label = opencodeToolLabel(tool, input);
      const diff = tool === "edit" ? diffStat(state.metadata) : undefined;
      const step: VaultActivityStep = {
        kind: "tool",
        tool: titleCase(tool),
        detail: label ? truncate(label) : undefined,
        diff,
      };
      activity.push(step);
      tl.push({ ts: p.timeCreated, item: step });
    } else if (type === "subtask") {
      subagentCount++;
      const name = strField(p.data.agent) ?? "subagent";
      const prompt = strField(p.data.prompt) ?? strField(p.data.description);
      const step: VaultActivityStep = { kind: "subagent", name, prompt: prompt ? truncate(prompt) : undefined };
      activity.push(step);
      tl.push({ ts: p.timeCreated, item: step });
    } else if (type === "reasoning") {
      const t = strField(p.data.text);
      if (t) {
        tl.push({ ts: p.timeCreated, item: { kind: "thinking", text: truncateRich(t, MAX_MESSAGE_TEXT) } });
      }
    }
  }

  // Nested sub-sessions (subagents / workflow children, linked by parent_id)
  // interleave at their spawn time alongside messages + tool/subtask steps.
  for (const c of childStubs) {
    tl.push({ ts: c.timestamp, item: c.item });
  }

  // Merge messages + tool/subtask steps into one chronological stream (stable
  // sort keeps same-timestamp items in their original push order).
  const merged = tl
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.ts - b.ts || a.i - b.i)
    .map((x) => x.item);
  const bounded = boundTimeline(merged, limit);

  return {
    firstPrompt,
    recentActivity: boundActivity(activity),
    latestMessage,
    timeline: bounded.timeline,
    ...(bounded.truncated ? { truncated: true } : {}),
    stats: {
      messageCount,
      toolCount,
      // Prefer the count of real child sub-sessions; fall back to subtask parts.
      subagentCount: childStubs.length > 0 ? childStubs.length : subagentCount,
      ...(sawTokens && tokenCount > 0 ? { tokenCount } : {}),
    },
  };
}

/**
 * On-demand bounded detail for an OpenCode session — queries its `message` +
 * `part` rows by id (no full-table scan) and maps them. Returns null when the
 * id is unsafe, the query fails, or no rows exist (session not found).
 */
export async function readOpenCodeDetail(
  sessionId: string,
  options: OpenCodeReaderOptions = {},
  limit?: number,
): Promise<VaultSessionDetail | null> {
  if (!isSafeOpenCodeId(sessionId)) {
    return null;
  }
  const home = options.home ?? os.homedir();
  const xdgData = process.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  const dataDir = options.dataDir ?? path.join(xdgData, "opencode");
  const dbPath = path.join(dataDir, "opencode.db");
  const readSqliteFn = options.readSqliteFn ?? readSqlite;

  // `sessionId` is validated to `[A-Za-z0-9_-]+` above, so embedding it in the
  // static query introduces no injectable characters (no quotes/semicolons).
  const messagesSql = `SELECT id, time_created, data FROM message WHERE session_id = '${sessionId}' ORDER BY time_created ASC LIMIT ${DETAIL_MESSAGE_LIMIT}`;
  const partsSql = `SELECT message_id, time_created, data FROM part WHERE session_id = '${sessionId}' ORDER BY time_created ASC LIMIT ${DETAIL_PART_LIMIT}`;
  // Direct children (subagents / workflow sub-sessions) of this session, with a
  // first-user-message subquery (reused from the list SQL) for the collapsed stub.
  const childrenSql = `SELECT s.id, s.title, s.agent, s.time_created, (
      SELECT p.data FROM part p JOIN message m ON p.message_id = m.id
      WHERE p.session_id = s.id AND m.data LIKE '%"role":"user"%'
        AND p.data LIKE '%"type":"text"%' AND p.data NOT LIKE '%"synthetic":true%'
      ORDER BY p.time_created ASC LIMIT 1
    ) AS first_user_part
    FROM session s WHERE s.parent_id = '${sessionId}' ORDER BY s.time_created ASC LIMIT ${CHILD_LIMIT}`;

  const [msgRes, partRes, childRes] = await Promise.all([
    readSqliteFn(dbPath, messagesSql),
    readSqliteFn(dbPath, partsSql),
    readSqliteFn(dbPath, childrenSql),
  ]);
  if (msgRes.status !== "ok" || partRes.status !== "ok") {
    return null;
  }
  if (msgRes.rows.length === 0) {
    return null; // session not found in the store
  }

  const messages = parseMessageRows(msgRes.rows);
  const parts = parsePartRows(partRes.rows);
  const childStubs = childRes.status === "ok" ? buildChildStubs(childRes.rows) : [];
  return { entryId: formatEntryId("opencode", sessionId), ...mapOpencodeRows(messages, parts, limit, childStubs) };
}

/** Map direct-child session rows into timestamped `subagentSession` stubs. */
function buildChildStubs(rows: Record<string, unknown>[]): { timestamp: number; item: VaultTimelineItem }[] {
  const stubs: { timestamp: number; item: VaultTimelineItem }[] = [];
  for (const row of rows) {
    const childId = asString(row.id);
    if (!childId) {
      continue;
    }
    const rawTitle = asString(row.title);
    const firstMessage = firstUserPartText(row.first_user_part);
    // Prefer the real title; fall back to the first user message for placeholders.
    const title = rawTitle && !isPlaceholderTitle(rawTitle) ? rawTitle : (firstMessage ?? rawTitle ?? "Subagent");
    const timestamp = Number(row.time_created) || 0;
    stubs.push({
      timestamp,
      item: {
        kind: "subagentSession",
        entryId: formatEntryId("opencode", childId),
        title: boundedPreview(title),
        ...(firstMessage ? { firstMessage: truncate(firstMessage) } : {}),
        ...(asString(row.agent) ? { agent: asString(row.agent) } : {}),
        timestamp,
      },
    });
  }
  return stubs;
}

function parseJsonData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") {
    return objField(raw) ?? null;
  }
  try {
    return objField(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

function parseMessageRows(rows: Record<string, unknown>[]): OcMessageRow[] {
  const out: OcMessageRow[] = [];
  for (const row of rows) {
    const id = strField(row.id);
    const data = parseJsonData(row.data);
    if (id && data) {
      out.push({ id, timeCreated: num(row.time_created), data });
    }
  }
  return out;
}

function parsePartRows(rows: Record<string, unknown>[]): OcPartRow[] {
  const out: OcPartRow[] = [];
  for (const row of rows) {
    const messageId = strField(row.message_id);
    const data = parseJsonData(row.data);
    if (messageId && data) {
      out.push({ messageId, timeCreated: num(row.time_created), data });
    }
  }
  return out;
}
