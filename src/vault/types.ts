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
}

export interface VaultListResult {
  entries: VaultSessionEntry[];
  /** Count of session files/rows that failed to parse (D8). */
  unreadable: number;
}
