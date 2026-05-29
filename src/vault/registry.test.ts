// src/vault/registry.test.ts — Unit tests for the agent registry.

import { describe, expect, it } from "vitest";
import { AGENT_ICONS } from "../webview/vault/agentIcons";
import {
  AGENT_DEFINITIONS,
  AGENT_REGISTRY,
  CLAUDE_AUTH_ENV_ALLOWLIST,
  getAgentDefinition,
  VAULT_AGENT_IDS,
} from "./registry";
import type { CommandTemplate } from "./types";

function staticTokens(t: CommandTemplate): string[] {
  return t.args.filter((a): a is string => typeof a === "string");
}

describe("AGENT_REGISTRY", () => {
  it("ships records for claude, codex, opencode", () => {
    expect(Object.keys(AGENT_REGISTRY).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(AGENT_DEFINITIONS.map((d) => d.id)).toEqual(["claude", "codex", "opencode"]);
  });

  it("every VAULT_AGENT_IDS entry has a registry definition (single source, no gap)", () => {
    expect([...VAULT_AGENT_IDS]).toEqual(["claude", "codex", "opencode"]);
    for (const id of VAULT_AGENT_IDS) {
      expect(getAgentDefinition(id)).toBeDefined();
    }
    // AGENT_DEFINITIONS is derived from VAULT_AGENT_IDS, so order tracks it.
    expect(AGENT_DEFINITIONS.map((d) => d.id)).toEqual([...VAULT_AGENT_IDS]);
  });

  it("each record's id equals its registry key (W2 — satisfies checks keys, not id===key)", () => {
    for (const id of VAULT_AGENT_IDS) {
      expect(getAgentDefinition(id)?.id).toBe(id);
    }
  });

  it("no agent id contains the entryId separator ':' (S1 — formatEntryId/parseEntryId invariant)", () => {
    for (const id of VAULT_AGENT_IDS) {
      expect(id).not.toContain(":");
    }
  });

  it("webview displayName matches the host registry displayName for every agent (W1)", () => {
    // displayName lives in two places (host registry + webview AGENT_ICONS); this
    // pins them so they can't silently diverge.
    for (const id of VAULT_AGENT_IDS) {
      expect(AGENT_ICONS[id]?.displayName).toBe(getAgentDefinition(id)?.displayName);
    }
  });

  it("every record's resume template carries the {{sessionId}} token", () => {
    for (const def of AGENT_DEFINITIONS) {
      expect(staticTokens(def.resumeCommand)).toContain("{{sessionId}}");
    }
  });

  it("claude carries the exact 8-var auth allowlist", () => {
    const claude = getAgentDefinition("claude");
    expect(claude?.authEnvAllowlist).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CONFIG_DIR",
    ]);
    expect(CLAUDE_AUTH_ENV_ALLOWLIST).toHaveLength(8);
  });

  it("claude resume injects model + permission-mode flags; fork uses --fork-session", () => {
    const claude = getAgentDefinition("claude");
    expect(claude?.resumeCommand.args).toContainEqual({ flag: "--model", from: "model" });
    expect(claude?.resumeCommand.args).toContainEqual({ flag: "--permission-mode", from: "permissionMode" });
    expect(staticTokens(claude?.forkCommand as CommandTemplate)).toContain("--fork-session");
  });

  it("codex resume preserves flag order m,a,s and templates reasoning effort", () => {
    const codex = getAgentDefinition("codex");
    const flags = codex?.resumeCommand.args.filter((a) => typeof a !== "string");
    expect(flags).toEqual([
      { flag: "-m", from: "model" },
      { flag: "-a", from: "approval" },
      { flag: "-s", from: "sandbox" },
      { flag: "-c", from: "reasoningEffort", valueTemplate: "model_reasoning_effort={{value}}" },
    ]);
    expect(staticTokens(codex?.resumeCommand as CommandTemplate)).toEqual(["resume", "{{sessionId}}"]);
  });

  it("opencode carries forkMinVersion 1.1.54 and a --fork command", () => {
    const opencode = getAgentDefinition("opencode");
    expect(opencode?.forkMinVersion).toBe("1.1.54");
    expect(staticTokens(opencode?.forkCommand as CommandTemplate)).toContain("--fork");
    expect(opencode?.resumeCommand.args).toContainEqual({ flag: "--agent", from: "agent" });
  });

  it("codex has no forkMinVersion (fork supported whenever a command exists)", () => {
    expect(getAgentDefinition("codex")?.forkMinVersion).toBeUndefined();
  });

  it("getAgentDefinition returns undefined for unknown agents", () => {
    expect(getAgentDefinition("nope")).toBeUndefined();
  });
});
