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
import { formatEntryId, type VaultSessionDetail, type VaultSessionEntry, type VaultTimelineItem } from "../types";
import {
  type ClaudeChildId,
  formatTeamTurnSessionId,
  formatWorkflowAgentSessionId,
  formatWorkflowSessionId,
  parseClaudeChildId,
} from "./claudeChildIds";
import {
  boundTimeline,
  type ClaudeChildStub,
  clampDetailLimit,
  classifyClaudeStyleEvents,
  cleanPromptText,
  createBoundedRecordBuffer,
  finalizeDetail,
  MAX_TIMELINE_ITEMS,
  mergeTimestampedItems,
  synthesizeGroupDetail,
} from "./detail";

/** Separates a parent session id from a subagent file stem in an entry id:
 *  `claude:<parentSessionId>:subagent:<agent-stem>`. */
const SUBAGENT_MARKER = ":subagent:";

/** Workflow run id / agent stem patterns — re-validated before any path join as
 *  defense-in-depth (the dispatch already parsed them via claudeChildIds). */
const WORKFLOW_ID_RE = /^wf_[A-Za-z0-9_-]+$/;
const WORKFLOW_AGENT_STEM_RE = /^agent-[A-Za-z0-9]+$/;

/** Cap on a workflow manifest read (review W5): manifests are normally tens-to-
 *  hundreds of KB; skip anything larger rather than materialize + parse it. */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

/** Read + parse a workflow manifest, bounded by {@link MAX_MANIFEST_BYTES} and
 *  defensive (missing / oversized / malformed → null, never throws — D8). */
async function readManifestJson(filePath: string): Promise<Record<string, unknown> | null> {
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
function coerceTimestamp(value: unknown): number | undefined {
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

/**
 * The SINGLE team-member predicate (D5, review W2): a record carries a team
 * identity iff it has BOTH a non-empty `agentName` and `teamName`. Membership is
 * decided on the session's FIRST text-bearing, non-meta, non-sidechain user
 * record — used identically by the list-exclusion path (`parseClaudeFile`) and
 * the grouping path (`readTeamMemberInfo`) so a session can never be both listed
 * and grouped.
 */
function recordTeamIdentity(obj: Record<string, unknown>): { agentName: string; teamName: string } | null {
  const an = obj.agentName;
  const tn = obj.teamName;
  if (typeof an === "string" && an.trim() !== "" && typeof tn === "string" && tn.trim() !== "") {
    return { agentName: an.trim(), teamName: tn.trim() };
  }
  return null;
}

/** RAW user text (string content or joined text blocks), WITHOUT the
 *  command-wrapper stripping `extractUserText` applies — so a
 *  `<teammate-message …>` tag survives intact for boundary detection. */
function rawUserText(message: unknown): string | undefined {
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

/**
 * A team coordination tag: `<teammate-message teammate_id="X" color? summary?>
 * BODY</teammate-message>`. In a MEMBER file each incoming message is one such
 * record (the turn boundary, D14); in the LEADER file the delivered replies carry
 * the member's `color`. `teammateId="team-lead"` ⇒ from the leader, otherwise a
 * peer member. Returns null when the text carries no tag.
 */
function parseTeammateTag(
  text: string,
): { teammateId: string; from: "leader" | "peer"; body: string; color?: string; summary?: string } | null {
  const open = /<teammate-message\b([^>]*)>/.exec(text);
  if (!open) {
    return null;
  }
  const attrs = open[1];
  const id = /\bteammate_id="([^"]*)"/.exec(attrs)?.[1];
  if (!id) {
    return null;
  }
  const after = text.slice(open.index + open[0].length);
  const closeAt = after.indexOf("</teammate-message>");
  const body = (closeAt >= 0 ? after.slice(0, closeAt) : after).trim();
  const color = /\bcolor="([^"]*)"/.exec(attrs)?.[1];
  const summary = /\bsummary="([^"]*)"/.exec(attrs)?.[1];
  return {
    teammateId: id,
    from: id === "team-lead" ? "leader" : "peer",
    body,
    ...(color ? { color } : {}),
    ...(summary ? { summary } : {}),
  };
}

/**
 * Adapter passed to {@link classifyClaudeStyleEvents} so an incoming
 * `<teammate-message …>` `user` record is emitted as a `teammateMessage` item
 * (clean body + sender) rather than a raw "USER" bubble (D16). Reuses the single
 * source of truth `parseTeammateTag`; null when the text bears no tag.
 */
function teammateMessageHook(
  rawText: string,
): { agentName: string; from: string; color?: string; body: string } | null {
  const tag = parseTeammateTag(rawText);
  if (!tag) {
    return null;
  }
  // Fall back to the tag's `summary` when the body is empty (a notification-style
  // `<teammate-message summary="…"></teammate-message>`): without this the empty
  // body unwraps to nothing and the record is dropped from BOTH the teammate path
  // and the plain-message path — a silent omission of a real on-disk message (R5).
  // Mirrors collectMemberTurns' `body || summary` preview.
  const body = tag.body || tag.summary || "";
  return { agentName: tag.teammateId, from: tag.from, ...(tag.color ? { color: tag.color } : {}), body };
}

/** A teammate-message turn boundary on a parsed record, or null. A boundary is a
 *  non-meta `user` record whose text bears a `<teammate-message>` tag. */
function teammateBoundary(rec: Record<string, unknown>): ReturnType<typeof parseTeammateTag> {
  if (rec.type !== "user" || rec.isMeta === true) {
    return null;
  }
  const text = rawUserText((rec as { message?: unknown }).message);
  return text ? parseTeammateTag(text) : null;
}

/**
 * A streaming side-collector for a parent session's team context (review W3/N1):
 * the `teamName`s it recorded (collected across the whole stream) and whether it
 * is itself a non-lead member (decided on the first text-bearing user record, the
 * same predicate as the list/grouping paths). Pass `.onRecord` to
 * `streamClaudeRecords`, then read `.ctx`. Centralizes the predicate so the
 * parent-detail path and the team-group resolver agree on leadership.
 */
function teamContextCollector(): {
  ctx: { teamNames: Set<string>; selfIsMember: boolean; colorByMember: Map<string, string> };
  onRecord: (rec: Record<string, unknown>) => void;
} {
  const ctx = { teamNames: new Set<string>(), selfIsMember: false, colorByMember: new Map<string, string>() };
  let firstUserSeen = false;
  return {
    ctx,
    onRecord: (rec) => {
      if (typeof rec.teamName === "string" && rec.teamName.trim() !== "") {
        ctx.teamNames.add(rec.teamName.trim());
      }
      // Leader-side delivered replies carry the member's color
      // (`<teammate-message teammate_id="X" color="Y">`) — collect a member→color
      // map so the thread highlights each teammate consistently (D14). First write
      // wins; `team-lead` is the leader itself (no member color).
      const tag = teammateBoundary(rec);
      if (tag && tag.teammateId !== "team-lead" && tag.color && !ctx.colorByMember.has(tag.teammateId)) {
        ctx.colorByMember.set(tag.teammateId, tag.color);
      }
      if (!firstUserSeen && rec.type === "user" && rec.isMeta !== true && rec.isSidechain !== true) {
        if (extractUserText(rec.message)) {
          firstUserSeen = true;
          ctx.selfIsMember = recordTeamIdentity(rec) !== null;
        }
      }
    },
  };
}

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
  /**
   * True when the session has real content: a human prompt (a non-meta user
   * record whose text survives `cleanPromptText`) OR an assistant turn (which
   * carries any tool use). A session with NEITHER — e.g. a transcript holding
   * only a `/clear` command + caveat banner — is junk the list hides (D18).
   */
  hasContent: boolean;
  /**
   * True when this session is a non-lead TEAM MEMBER: an early record (within the
   * metadata head scan) carries BOTH a non-empty `agentName` and `teamName` — it
   * was born into a team rather than spawning one. The top-level list excludes
   * these (nest-workflow-team-sessions D5); a leader has neither on its early
   * records (the team is created mid-session). The predicate MUST match the
   * team-grouping predicate (D4) so an `agentName`-only session is never hidden.
   */
  isTeamMember: boolean;
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
  const fields: ClaudeFileFields = { parsedAnyLine: false, isTeamMember: false, hasContent: false };
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
          // Team-member detection (D5, W2): decided on this FIRST identity record
          // — a teammate is born into a team with both fields here; a leader has
          // neither (the team it later creates comes after this record).
          fields.isTeamMember = recordTeamIdentity(obj) !== null;
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
  fields.hasContent = haveUser || haveAssistant;
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
  // A child id carries a marker (`:subagent:` / `:workflow:` / `:wfagent:` /
  // `:team:`); a plain session id parses to null and falls through to the
  // main-session path below. Each child branch resolves by id under the projects
  // root (containment-checked) — never a webview-supplied path (D2/D6).
  const child = parseClaudeChildId(sessionId);
  if (child) {
    return readClaudeChildDetail(child, sessionId, options, limit);
  }

  const filePath = await resolveClaudeSessionPath(sessionId, options);
  if (!filePath) {
    return null;
  }
  // Collect the leader's team context across the WHOLE stream (even records the
  // head+tail bound later drops) so a team episode buried mid-transcript is still
  // grouped (D4), and detect whether THIS session is itself a non-lead member —
  // a member must NOT synthesize its own Team group (recursive peer nesting, W3),
  // so team groups are leader-only.
  const { ctx, onRecord } = teamContextCollector();
  const read = await streamClaudeRecords(filePath, { onRecord });
  if (read === null) {
    return null;
  }
  // childStubs = flat subagents ∪ workflow groups (each folds into its spawn call
  // or merges by timestamp). Team members are NOT collapsed groups any more:
  // their communication turns are threaded as `teammateTurn` nodes (D13/D14). A
  // member resolves an empty team set → no teammate turns under it (W3).
  const teamScanNames = ctx.selfIsMember ? new Set<string>() : ctx.teamNames;
  const [subStubs, wfStubs, teammateTurns] = await Promise.all([
    listClaudeSubagentStubs(sessionId, options),
    listClaudeWorkflowStubs(sessionId, options),
    buildTeamThread(filePath, teamScanNames, ctx.colorByMember),
  ]);
  const childStubs = [...subStubs, ...wfStubs];
  const detail = classifyClaudeStyleEvents(read.records, { limit, childStubs, teammateMessage: teammateMessageHook });
  // Thread the teammate turns into the classified timeline by timestamp, then
  // re-bound (classify already bounded its own stream-derived items) (D14).
  if (teammateTurns.length > 0) {
    const merged = mergeTimestampedItems(detail.timeline, teammateTurns);
    const bounded = boundTimeline(merged, clampDetailLimit(limit) ?? MAX_TIMELINE_ITEMS);
    detail.timeline = bounded.timeline;
    if (bounded.truncated) {
      detail.truncated = true;
    }
  }
  return finalizeDetail(formatEntryId("claude", sessionId), detail, read.truncated);
}

/** Dispatch a parsed child id to its resolver (nest-workflow-team-sessions D2). */
async function readClaudeChildDetail(
  child: ClaudeChildId,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  switch (child.kind) {
    case "subagent":
      return readClaudeSubagentDetail(child.parentId, child.stem, sessionId, options, limit);
    case "workflow":
      return readClaudeWorkflowDetail(child.parentId, child.wfId, sessionId, options, limit);
    case "wfagent":
      return readClaudeWorkflowAgentDetail(child.parentId, child.wfId, child.stem, sessionId, options, limit);
    case "teamTurn":
      return readClaudeTeamSegment(child.memberId, child.turn, options, limit);
  }
}

/**
 * Open ONE communication turn of a member session (D12): the records from the
 * n-th `<teammate-message>` boundary up to the next boundary (or EOF) — i.e. from
 * receiving the request through the member's response. The member file is located
 * by id under the projects root (containment-checked); only the target window is
 * retained (boundaries elsewhere are counted, not buffered). An out-of-range turn
 * or unsafe id → null. View-only: the `:turn:` id is never launchable.
 */
async function readClaudeTeamSegment(
  memberId: string,
  turn: number,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  if (!isSafeSessionId(memberId) || !Number.isInteger(turn) || turn < 0) {
    return null;
  }
  const filePath = await resolveClaudeSessionPath(memberId, options);
  if (!filePath) {
    return null;
  }
  // A single turn (a long-running member's whole response between two boundaries)
  // can span most of the file, so the collected window is head+tail bounded like
  // any detail read (R5) — never the full remainder materialized at once.
  const buffer = createBoundedRecordBuffer();
  let boundaryCount = 0;
  let collecting = false;
  let found = false;
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
      let rec: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        rec = parsed as Record<string, unknown>;
      } catch {
        continue; // skip a corrupt line, keep counting (D8)
      }
      if (teammateBoundary(rec) !== null) {
        if (boundaryCount === turn) {
          collecting = true;
          found = true;
        } else if (collecting) {
          break; // reached the next boundary — the target turn ends here
        }
        boundaryCount++;
      }
      if (collecting) {
        buffer.push(rec);
      }
    }
  } catch {
    return null;
  } finally {
    rl?.close();
    stream?.destroy();
  }
  if (!found) {
    return null; // turn out of range
  }
  const { records, truncated } = buffer.result();
  const detail = classifyClaudeStyleEvents(records, {
    limit,
    includeSidechain: true,
    teammateMessage: teammateMessageHook,
  });
  return finalizeDetail(formatEntryId("claude", formatTeamTurnSessionId(memberId, turn)), detail, truncated);
}

/** A flat subagent leaf: its records are all `isSidechain` (that IS the
 *  conversation here), so classify with `includeSidechain`. */
async function readClaudeSubagentDetail(
  parentId: string,
  stem: string,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
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

/**
 * Workflow GROUP detail (D3): list the run's agents under
 * `<parentId>/subagents/workflows/<wfId>/` as title-only nested sessions (each a
 * lazy `:wfagent:` leaf), labelled by their first prompt. The manifest's summary
 * leads the group. Parent/dir unknown → null.
 */
async function readClaudeWorkflowDetail(
  parentId: string,
  wfId: string,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  if (!isSafeSessionId(parentId) || !WORKFLOW_ID_RE.test(wfId)) {
    return null;
  }
  const parentPath = await resolveClaudeSessionPath(parentId, options);
  if (!parentPath) {
    return null;
  }
  const projectDir = path.dirname(parentPath);
  const { projectsDir } = claudeRoots(options);
  const agentsDir = path.join(projectDir, parentId, "subagents", "workflows", wfId);
  const agentsRel = path.relative(projectsDir, agentsDir);
  if (agentsRel.startsWith("..") || path.isAbsolute(agentsRel)) {
    return null;
  }
  // Manifest summary leads the group (best-effort; bounded + defensive, W5/D8).
  const manifest = await readManifestJson(path.join(projectDir, parentId, "workflows", `${wfId}.json`));
  const summary = manifest && typeof manifest.summary === "string" ? manifest.summary : undefined;
  let files: string[];
  try {
    files = await fs.readdir(agentsDir);
  } catch {
    return null; // no agents dir → the workflow id doesn't resolve
  }
  const stems = files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((s) => WORKFLOW_AGENT_STEM_RE.test(s))
    .sort();
  const children: ClaudeChildStub[] = [];
  for (const stem of stems) {
    const first = await readFirstUserRecord(path.join(agentsDir, `${stem}.jsonl`));
    children.push({
      entryId: formatEntryId("claude", formatWorkflowAgentSessionId(parentId, wfId, stem)),
      description: first?.text ? boundedPreview(first.text) : stem,
      isGroup: true, // title-only: the first-prompt label, no agent chip
      ...(first?.text ? { firstMessage: first.text } : {}),
      ...(first?.timestamp ? { timestamp: first.timestamp } : {}),
    });
  }
  return synthesizeGroupDetail(formatEntryId("claude", sessionId), children, {
    firstPrompt: summary,
    subagentCount: children.length,
    limit,
  });
}

/** A workflow agent leaf (D3): its records are all `isSidechain` (the agent's own
 *  conversation), so classify with `includeSidechain`. */
async function readClaudeWorkflowAgentDetail(
  parentId: string,
  wfId: string,
  stem: string,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  const filePath = await resolveClaudeWorkflowAgentPath(parentId, wfId, stem, options);
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

/**
 * Resolve a workflow agent transcript at
 * `<projects>/<dir>/<parentId>/subagents/workflows/<wfId>/<stem>.jsonl`. All id
 * parts are validated against fixed patterns and the resolved path is
 * containment-checked under the projects root — the host never trusts the
 * webview-supplied composite id (D6).
 */
async function resolveClaudeWorkflowAgentPath(
  parentId: string,
  wfId: string,
  stem: string,
  options: ClaudeReaderOptions,
): Promise<string | null> {
  if (!isSafeSessionId(parentId) || !WORKFLOW_ID_RE.test(wfId) || !WORKFLOW_AGENT_STEM_RE.test(stem)) {
    return null;
  }
  const parentPath = await resolveClaudeSessionPath(parentId, options);
  if (!parentPath) {
    return null;
  }
  const candidate = path.join(path.dirname(parentPath), parentId, "subagents", "workflows", wfId, `${stem}.jsonl`);
  const { projectsDir } = claudeRoots(options);
  const rel = path.relative(projectsDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  try {
    return (await fs.stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Discover the parent session's `/workflow` runs (D3) as one collapsed GROUP stub
 * per run. Manifests live at `<parentId>/workflows/wf_*.json`; the stub's label
 * and placement come from the manifest (the parent's `Workflow` tool call has no
 * run id). A missing `workflows/` dir → `[]`; a malformed manifest is skipped.
 */
export async function listClaudeWorkflowStubs(
  parentId: string,
  options: ClaudeReaderOptions = {},
): Promise<ClaudeChildStub[]> {
  if (!isSafeSessionId(parentId)) {
    return [];
  }
  const parentPath = await resolveClaudeSessionPath(parentId, options);
  if (!parentPath) {
    return [];
  }
  const wfDir = path.join(path.dirname(parentPath), parentId, "workflows");
  const { projectsDir } = claudeRoots(options);
  const rel = path.relative(projectsDir, wfDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return [];
  }
  let files: string[];
  try {
    files = await fs.readdir(wfDir);
  } catch {
    return []; // no workflows dir → the common case
  }
  const stubs: ClaudeChildStub[] = [];
  for (const name of files) {
    if (!name.startsWith("wf_") || !name.endsWith(".json")) {
      continue;
    }
    const wfId = name.slice(0, -".json".length);
    if (!WORKFLOW_ID_RE.test(wfId)) {
      continue;
    }
    const manifest = await readManifestJson(path.join(wfDir, name));
    if (!manifest) {
      continue; // missing / oversized / malformed — skip, don't throw (W5/D8)
    }
    const wfName = typeof manifest.workflowName === "string" ? manifest.workflowName : wfId;
    const agentCount = typeof manifest.agentCount === "number" ? manifest.agentCount : Number(manifest.agentCount) || 0;
    const status = typeof manifest.status === "string" ? manifest.status : "";
    const summary = typeof manifest.summary === "string" ? manifest.summary : undefined;
    const ts = coerceTimestamp(manifest.startTime) ?? coerceTimestamp(manifest.timestamp);
    const label = `Workflow: ${wfName} · ${agentCount} agent${agentCount === 1 ? "" : "s"}${status ? ` · ${status}` : ""}`;
    stubs.push({
      entryId: formatEntryId("claude", formatWorkflowSessionId(parentId, wfId)),
      description: label,
      isGroup: true,
      ...(summary ? { firstMessage: summary } : {}),
      ...(ts !== undefined ? { timestamp: ts } : {}),
    });
  }
  stubs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return stubs;
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

/** A discovered non-lead team member (sibling session sharing a `teamName`). */
interface TeamMemberInfo {
  sessionId: string;
  agentName: string;
  teamName: string;
  /** First user text (collapsed-block preview for the member node). */
  firstMessage?: string;
  /** First-record timestamp (coerced; placement of the team group). */
  timestamp?: number;
}

/**
 * Read a sibling session's team identity, decided on its FIRST text-bearing,
 * non-meta, non-sidechain user record — the EXACT same record + predicate the
 * list-exclusion path uses (W2), so a session can't be both listed and grouped.
 * Returns null when that record carries no team identity (not a member). Bounded
 * to that first user record — a non-member is never read to EOF.
 */
async function readTeamMemberInfo(filePath: string, sessionId: string): Promise<TeamMemberInfo | null> {
  let stream: ReturnType<typeof createReadStream> | undefined;
  let rl: readline.Interface | undefined;
  let result: TeamMemberInfo | null = null;
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
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        obj = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type !== "user" || obj.isMeta === true || obj.isSidechain === true) {
        continue;
      }
      const text = extractUserText(obj.message);
      if (!text) {
        continue; // a pure tool_result user record is not the identity record
      }
      // First identity record reached: membership is decided here and nowhere else.
      const identity = recordTeamIdentity(obj);
      if (identity) {
        result = {
          sessionId,
          agentName: identity.agentName,
          teamName: identity.teamName,
          firstMessage: text,
          timestamp: coerceTimestamp(obj.timestamp),
        };
      }
      break;
    }
  } catch {
    return null;
  } finally {
    rl?.close();
    stream?.destroy();
  }
  return result;
}

/**
 * Scan a project dir for the parent's team members: each OTHER `<id>.jsonl`
 * whose first identity record's `teamName` is one the parent participated in.
 * Returns members grouped by `teamName`. Drives the threaded teammate timeline
 * (buildTeamThread, D14).
 */
async function scanTeamMembers(
  projectDir: string,
  parentId: string,
  teamNames: Set<string>,
): Promise<Map<string, TeamMemberInfo[]>> {
  const byTeam = new Map<string, TeamMemberInfo[]>();
  if (teamNames.size === 0) {
    return byTeam;
  }
  let files: string[];
  try {
    files = await fs.readdir(projectDir);
  } catch {
    return byTeam;
  }
  for (const name of files) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const stem = name.slice(0, -".jsonl".length);
    if (stem === parentId || !isSafeSessionId(stem)) {
      continue;
    }
    const info = await readTeamMemberInfo(path.join(projectDir, name), stem);
    if (!info || !teamNames.has(info.teamName)) {
      continue;
    }
    const arr = byTeam.get(info.teamName) ?? [];
    arr.push(info);
    byTeam.set(info.teamName, arr);
  }
  return byTeam;
}

/** Fixed accent palette for members whose color the leader never recorded (D14).
 *  Names map to concrete CSS colors webview-side; raw names are also accepted. */
const TEAMMATE_PALETTE = ["blue", "green", "yellow", "purple", "cyan", "orange", "pink", "red"] as const;

/** One incoming-message turn discovered in a member file. */
interface MemberTurn {
  idx: number;
  from: string; // "leader" | "<peerName>"
  preview: string;
  timestamp: number;
}

/** Stream a member file once and emit one {@link MemberTurn} per
 *  `<teammate-message>` boundary (D14). Retains only per-boundary metadata, never
 *  the full transcript. */
async function collectMemberTurns(filePath: string): Promise<MemberTurn[]> {
  const turns: MemberTurn[] = [];
  let idx = 0;
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
      let rec: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        rec = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const tag = teammateBoundary(rec);
      if (tag) {
        turns.push({
          idx,
          from: tag.from === "leader" ? "leader" : tag.teammateId,
          preview: tag.body || tag.summary || "",
          timestamp: coerceTimestamp(rec.timestamp) ?? 0,
        });
        idx++;
        // Keep only the most-recent window in memory (R5). `idx` keeps counting,
        // so each retained turn's true boundary ordinal — the `:turn:<n>` id used
        // to re-open it — is unchanged; only old, beyond-the-cap turns are dropped
        // (they would not survive the leader timeline's final tail bound anyway).
        if (turns.length > MAX_TIMELINE_ITEMS) {
          turns.shift();
        }
      }
    }
  } catch {
    return turns; // partial is fine — defensive (D8)
  } finally {
    rl?.close();
    stream?.destroy();
  }
  return turns;
}

/**
 * Peer-aware team thread (D14): scan each member sibling of the leader and emit a
 * `teammateTurn` per incoming `<teammate-message>` boundary. `from` is `"leader"`
 * (sender `team-lead`) or the peer member name; `color` comes from the leader's
 * delivered-reply records, else a fixed palette by index. Each message is recorded
 * once (in its recipient's file), so leader↔member AND member↔member turns are
 * covered with no double-count. Empty when the leader recorded no `teamName`
 * (gated by the caller). Returned UNSORTED — the caller merges by timestamp.
 */
async function buildTeamThread(
  leaderPath: string,
  teamNames: Set<string>,
  colorByMember: Map<string, string>,
): Promise<VaultTimelineItem[]> {
  if (teamNames.size === 0) {
    return [];
  }
  const projectDir = path.dirname(leaderPath);
  const leaderId = path.basename(leaderPath).replace(/\.jsonl$/, "");
  const byTeam = await scanTeamMembers(projectDir, leaderId, teamNames);
  const items: VaultTimelineItem[] = [];
  let paletteIdx = 0;
  for (const members of byTeam.values()) {
    for (const m of members) {
      let color = colorByMember.get(m.agentName);
      if (!color) {
        color = TEAMMATE_PALETTE[paletteIdx % TEAMMATE_PALETTE.length];
        paletteIdx++;
      }
      const turns = await collectMemberTurns(path.join(projectDir, `${m.sessionId}.jsonl`));
      for (const t of turns) {
        items.push({
          kind: "teammateTurn",
          entryId: formatEntryId("claude", formatTeamTurnSessionId(m.sessionId, t.idx)),
          agentName: m.agentName,
          ...(color ? { color } : {}),
          from: t.from,
          preview: boundedPreview(t.preview),
          timestamp: t.timestamp,
        });
      }
    }
  }
  // Globally bound the thread before it is merged into the leader timeline (R5):
  // each member is already tail-capped, but a many-member team could still sum to
  // a large array. Keep the most-recent window by timestamp — exactly the slice
  // the caller's final tail bound would retain anyway.
  if (items.length > MAX_TIMELINE_ITEMS) {
    items.sort(
      (a, b) => ((a as { timestamp?: number }).timestamp ?? 0) - ((b as { timestamp?: number }).timestamp ?? 0),
    );
    return items.slice(items.length - MAX_TIMELINE_ITEMS);
  }
  return items;
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
): Promise<{ entry: VaultSessionEntry; isTeamMember: boolean; isEmpty: boolean } | null> {
  const stat = await fs.stat(filePath);
  const fields = await parseClaudeFile(filePath);
  if (!fields) {
    return null;
  }
  // Prefer Claude's own regenerated title; fall back to the first prompt.
  const aiTitle = await readLatestAiTitle(filePath);
  const entry: VaultSessionEntry = {
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
  // isTeamMember / isEmpty ride alongside (not on the entry) so the list path can
  // EXCLUDE members (D5) and content-less junk (D18), while the single-entry
  // resolve still returns them — both are real sessions, launchable by explicit
  // id even when hidden from the list.
  return { entry, isTeamMember: fields.isTeamMember, isEmpty: !fields.hasContent };
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
        const built = await buildClaudeEntry(filePath, sessionId, configDir);
        if (!built) {
          unreadable++;
        } else if (built.isTeamMember || built.isEmpty) {
          // Members thread under their leader (D5); content-less sessions
          // (only a /clear, a caveat banner, …) are junk — neither is listed (D18).
        } else {
          entries.push(built.entry);
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
    // Resolve-by-id returns the entry even for a team member (it's a real,
    // launchable session) — only the list path hides members (D5).
    const built = await buildClaudeEntry(filePath, sessionId, configDir);
    return built ? built.entry : null;
  } catch {
    return null;
  }
}
