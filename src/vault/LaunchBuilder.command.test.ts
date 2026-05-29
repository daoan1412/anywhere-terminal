// src/vault/LaunchBuilder.command.test.ts — Resume-command string (redesign-vault-panel-ui 3_1).

import { describe, expect, it } from "vitest";
import { buildResumeCommandString, VaultLaunchError } from "./LaunchBuilder";
import type { VaultSessionEntry } from "./types";

function entry(over: Partial<VaultSessionEntry> = {}): VaultSessionEntry {
  return {
    id: "claude:s1",
    agent: "claude",
    sessionId: "s1",
    title: "t",
    cwd: "/x",
    modified: 1,
    flags: {},
    canFork: false,
    ...over,
  };
}

describe("buildResumeCommandString", () => {
  it("renders a minimal Claude resume command (no optional flags)", () => {
    expect(buildResumeCommandString(entry({ agent: "claude", sessionId: "abc-123" }))).toBe("claude --resume abc-123");
  });

  it("includes captured Claude flags when present", () => {
    const cmd = buildResumeCommandString(
      entry({ agent: "claude", sessionId: "abc", flags: { model: "claude-opus-4-7", permissionMode: "plan" } }),
    );
    expect(cmd).toBe("claude --resume abc --model claude-opus-4-7 --permission-mode plan");
  });

  it("renders Codex with its flags incl. the reasoning-effort -c template", () => {
    const cmd = buildResumeCommandString(
      entry({
        agent: "codex",
        sessionId: "x1",
        flags: { model: "gpt-5", approval: "on-request", sandbox: "workspace-write", reasoningEffort: "high" },
      }),
    );
    expect(cmd).toBe("codex resume x1 -m gpt-5 -a on-request -s workspace-write -c model_reasoning_effort=high");
  });

  it("renders OpenCode with model + agent flags", () => {
    const cmd = buildResumeCommandString(
      entry({ agent: "opencode", sessionId: "ses_9", flags: { model: "anthropic/claude", agent: "build" } }),
    );
    expect(cmd).toBe("opencode --session ses_9 -m anthropic/claude --agent build");
  });

  it("single-quote wraps a flag value containing a space", () => {
    const cmd = buildResumeCommandString(entry({ agent: "claude", sessionId: "abc", flags: { model: "my model" } }));
    expect(cmd).toBe("claude --resume abc --model 'my model'");
  });

  it("throws for an unknown agent", () => {
    expect(() => buildResumeCommandString(entry({ agent: "mystery" }))).toThrow(VaultLaunchError);
  });
});
