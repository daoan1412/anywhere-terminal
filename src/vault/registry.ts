// src/vault/registry.ts — Data-driven AI CLI agent definitions.
// See: asimov/changes/add-ai-coding-vault/specs/agent-vault-registry/spec.md,
//      design.md D1, docs/research/20260528-cmux-vault-mechanism.md §1,§5,§6,§7.
//
// Launch (resume/fork) is fully data-driven from these records (D1): adding an
// agent's launch needs only a record here. History *reading* still needs a
// small per-agent reader (src/vault/readers/) because path layout + schema
// differ per agent.

import type { AgentVaultDefinition } from "./types";

/**
 * Claude's auth/config env allowlist — the only host env vars forwarded to a
 * resumed/forked Claude so it targets the same account (research §5,
 * RestorableAgentSession.swift:276-286). Version-fragile by design: kept here
 * so a drift fix is one line.
 */
export const CLAUDE_AUTH_ENV_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
] as const;

const claude: AgentVaultDefinition = {
  id: "claude",
  displayName: "Claude Code",
  detect: { executable: "claude" },
  sessionStore: {
    format: "jsonl",
    pathTemplate: "<$CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded-cwd>/*.jsonl",
  },
  sessionIdSource: "filename-stem",
  // claude --resume <sessionId> [--model <m>] [--permission-mode <p>]
  resumeCommand: {
    executable: "claude",
    args: [
      "--resume",
      "{{sessionId}}",
      { flag: "--model", from: "model" },
      { flag: "--permission-mode", from: "permissionMode" },
    ],
  },
  // claude --resume <sessionId> --fork-session
  forkCommand: {
    executable: "claude",
    args: ["--resume", "{{sessionId}}", "--fork-session"],
  },
  cwdPolicy: "preserve",
  authEnvAllowlist: [...CLAUDE_AUTH_ENV_ALLOWLIST],
};

const codex: AgentVaultDefinition = {
  id: "codex",
  displayName: "Codex",
  detect: { executable: "codex" },
  sessionStore: {
    format: "sqlite",
    pathTemplate: "~/.codex/state_5.sqlite (threads); fallback ~/.codex/sessions/**/*.jsonl",
  },
  sessionIdSource: "threads.id",
  // codex resume <sessionId> [-m <m>] [-a <approval>] [-s <sandbox>] [-c model_reasoning_effort=<e>]
  resumeCommand: {
    executable: "codex",
    args: [
      "resume",
      "{{sessionId}}",
      { flag: "-m", from: "model" },
      { flag: "-a", from: "approval" },
      { flag: "-s", from: "sandbox" },
      { flag: "-c", from: "reasoningEffort", valueTemplate: "model_reasoning_effort={{value}}" },
    ],
  },
  // codex fork <sessionId>
  forkCommand: {
    executable: "codex",
    args: ["fork", "{{sessionId}}"],
  },
  cwdPolicy: "preserve",
};

const opencode: AgentVaultDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  detect: { executable: "opencode" },
  sessionStore: {
    format: "sqlite",
    pathTemplate: "~/.local/share/opencode/opencode.db (session)",
  },
  sessionIdSource: "session.id",
  // opencode --session <sessionId> [-m <model>] [--agent <agent>]
  resumeCommand: {
    executable: "opencode",
    args: ["--session", "{{sessionId}}", { flag: "-m", from: "model" }, { flag: "--agent", from: "agent" }],
  },
  // opencode --session <sessionId> --fork (gated ≥ 1.14.50)
  forkCommand: {
    executable: "opencode",
    args: ["--session", "{{sessionId}}", "--fork"],
  },
  forkMinVersion: "1.14.50",
  cwdPolicy: "preserve",
};

export const AGENT_REGISTRY: Record<string, AgentVaultDefinition> = {
  claude,
  codex,
  opencode,
};

/** Registry records in a stable order (claude, codex, opencode). */
export const AGENT_DEFINITIONS: AgentVaultDefinition[] = [claude, codex, opencode];

export function getAgentDefinition(id: string): AgentVaultDefinition | undefined {
  return AGENT_REGISTRY[id];
}
