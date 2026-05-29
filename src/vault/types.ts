// src/vault/types.ts — Shared vault types (agent registry + session index).
// See: asimov/changes/add-ai-coding-vault/design.md Interfaces, D1, D4.

export type SessionStoreFormat = "jsonl" | "sqlite";

export interface AgentDetectRule {
  /** Executable basename used to detect / launch the agent. */
  executable: string;
  /** Optional argv needles that must all be present for a process to match. */
  argvContains?: string[];
}

export interface SessionStoreDescriptor {
  format: SessionStoreFormat;
  /**
   * Documents where this agent's sessions live. Actual path resolution +
   * parsing lives in the per-agent reader (D1): layout/schema differ per
   * agent even within a shared `format`, so this string anchors the reader
   * rather than driving it.
   */
  pathTemplate: string;
}

/** A captured per-session flag value, re-injected into a launch command. */
export interface VaultSessionFlags {
  model?: string;
  permissionMode?: string;
  approval?: string;
  sandbox?: string;
  reasoningEffort?: string;
  agent?: string;
  configDir?: string;
}

export interface FlagFragment {
  /** The CLI flag token, e.g. "--model" or "-m". */
  flag: string;
  /** Which captured flag value fills this fragment; skipped when absent. */
  from: keyof VaultSessionFlags;
  /**
   * Optional value shape; `{{value}}` is replaced by the captured value.
   * Defaults to the raw value. Used by codex's `-c model_reasoning_effort=<e>`.
   */
  valueTemplate?: string;
}

export interface CommandTemplate {
  executable: string;
  /**
   * Static argv tokens (may contain `{{sessionId}}` / `{{sessionPath}}` /
   * `{{executable}}`) interleaved with optional flag fragments that expand
   * only when the captured value is present.
   */
  args: Array<string | FlagFragment>;
}

export interface AgentVaultDefinition {
  id: string;
  displayName: string;
  detect: AgentDetectRule;
  sessionStore: SessionStoreDescriptor;
  /** How the session id is derived from the store (per-reader, D1). */
  sessionIdSource: string;
  /** Tokens: `{{sessionId}}` `{{sessionPath}}` `{{executable}}`. */
  resumeCommand: CommandTemplate;
  forkCommand?: CommandTemplate;
  /** Minimum agent `--version` for fork support (e.g. opencode "1.14.50"). */
  forkMinVersion?: string;
  /** MVP: always launch in the session's recorded cwd. */
  cwdPolicy: "preserve";
  /** Env var names propagated to the spawned process (claude auth/config). */
  authEnvAllowlist?: string[];
}

export interface VaultSessionEntry {
  /** "<agent>:<sessionId>", globally unique. */
  id: string;
  agent: string;
  sessionId: string;
  /** Bounded title preview only (D4). */
  title: string;
  cwd: string;
  /** epoch ms; list sorted desc. */
  modified: number;
  flags: VaultSessionFlags;
  /** Resolved against `forkMinVersion` at list time. */
  canFork: boolean;
  /**
   * UI hint ONLY (redesign-vault-panel-ui D9): present iff the session is
   * backed by an on-disk file (Claude always; Codex when a rollout jsonl
   * exists). Its presence tells the webview whether to render the
   * file-targeting context-menu items — it is NEVER used as an action's path
   * input. The host re-derives any path from `sessionId` server-side.
   * DB-backed sessions (OpenCode) leave it undefined.
   */
  sessionPath?: string;
}

/**
 * One step in a session's recent-activity timeline (redesign-vault-panel-ui
 * D6). Records tool **calls** and subagent invocations only — never tool
 * results as standalone steps.
 */
export type VaultActivityStep =
  | { kind: "tool"; tool: string; detail?: string; diff?: { added: number; removed: number } }
  | { kind: "subagent"; name: string; prompt?: string };

/**
 * One entry in the preview's full conversation timeline: a user/assistant
 * message, or a tool/subagent step (reusing {@link VaultActivityStep}). Ordered
 * chronologically by the readers.
 */
export type VaultTimelineItem =
  | { kind: "message"; role: "user" | "assistant"; text: string; timestamp?: number }
  | { kind: "thinking"; text: string; timestamp?: number }
  /**
   * A nested sub-session (a subagent / workflow child). A lazy stub: `title` +
   * `firstMessage` render the collapsed block; the full transcript is fetched on
   * demand via `entryId` (the resolvable `<agent>:<id>` — OpenCode children by
   * `parent_id`, Claude subagents by their `<sessionId>:subagent:<file>` token).
   * (redesign-vault-panel-ui — fold subagents into the parent preview.)
   */
  | {
      kind: "subagentSession";
      entryId: string;
      title: string;
      firstMessage?: string;
      agent?: string;
      timestamp?: number;
    }
  | VaultActivityStep;

/**
 * On-demand, bounded per-session detail for the preview overlay
 * (redesign-vault-panel-ui D4/D5). Read fresh per row activation — never cached.
 */
export interface VaultSessionDetail {
  /** Echoes the requesting entry id (`<agent>:<sessionId>`). */
  entryId: string;
  /** First real user prompt, truncated (≤ ~600 chars); independent of the tail. */
  firstPrompt?: string;
  /** Most-recent-last, capped to 12, calls + subagents only. */
  recentActivity: VaultActivityStep[];
  /** Last non-sidechain message; independent of the bounded tail. */
  latestMessage?: { role: "user" | "assistant"; text: string; timestamp: number };
  /**
   * Full chronological conversation: user/assistant messages interleaved with
   * tool/subagent steps. Bounded to the most-recent {@link MAX_TIMELINE_ITEMS};
   * `truncated` flags when older items were dropped. Drives the scrollable
   * preview transcript (redesign-vault-panel-ui — full transcript view).
   */
  timeline: VaultTimelineItem[];
  /** True when older timeline items were dropped to stay within the bound. */
  truncated?: boolean;
  stats: { messageCount: number; toolCount: number; subagentCount: number; tokenCount?: number };
  /** True when built from an index, not a transcript (Codex without a rollout). */
  partial?: boolean;
  /** Short reason surfaced in the preview when `partial`. */
  limitedReason?: string;
}

export interface VaultListResult {
  entries: VaultSessionEntry[];
  /**
   * Sessions that failed to parse (D8) — `count` drives the inline notice,
   * `reasons` (deduped, per-source) backs its "Details" affordance
   * (redesign-vault-panel-ui).
   */
  unreadable: { count: number; reasons: string[] };
}
