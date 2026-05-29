// src/vault/VaultLauncher.test.ts — Unit tests for entry→createSession resolution.

import { describe, expect, it } from "vitest";
import { VaultLaunchError } from "./LaunchBuilder";
import type { VaultListResult, VaultSessionEntry } from "./types";
import { VaultLauncher } from "./VaultLauncher";
import type { VaultService } from "./VaultService";

function makeEntry(overrides: Partial<VaultSessionEntry> = {}): VaultSessionEntry {
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

function stubService(entries: VaultSessionEntry[]): VaultService {
  return {
    list: async (): Promise<VaultListResult> => ({ entries, unreadable: { count: 0, reasons: [] } }),
  } as unknown as VaultService;
}

describe("VaultLauncher.resolve", () => {
  it("maps a claude resume to createSession options with the auth env override", async () => {
    const launcher = new VaultLauncher(stubService([makeEntry({ flags: { model: "claude-opus-4-7" } })]), {
      ANTHROPIC_API_KEY: "sk-1",
    });
    const opts = await launcher.resolve("claude:sess-1", "resume");
    expect(opts.shell).toBe("claude");
    expect(opts.shellArgs).toEqual(["--resume", "sess-1", "--model", "claude-opus-4-7"]);
    expect(opts.cwd).toBe("/Users/me/proj");
    expect(opts.env).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
  });

  it("omits env for non-claude agents", async () => {
    const entry = makeEntry({ id: "codex:t1", agent: "codex", sessionId: "t1", cwd: "/c" });
    const launcher = new VaultLauncher(stubService([entry]), {});
    const opts = await launcher.resolve("codex:t1", "resume");
    expect(opts.shell).toBe("codex");
    expect(opts.shellArgs).toEqual(["resume", "t1"]);
    expect(opts.env).toBeUndefined();
  });

  it("resolves a fork when the entry is forkable", async () => {
    const launcher = new VaultLauncher(stubService([makeEntry({ canFork: true })]), {});
    const opts = await launcher.resolve("claude:sess-1", "fork");
    expect(opts.shellArgs).toContain("--fork-session");
  });

  it("throws fork-unsupported when forking a non-forkable entry", async () => {
    const launcher = new VaultLauncher(stubService([makeEntry({ canFork: false })]), {});
    await expect(launcher.resolve("claude:sess-1", "fork")).rejects.toMatchObject({ code: "fork-unsupported" });
  });

  it("throws unknown-entry for an id not in the list", async () => {
    const launcher = new VaultLauncher(stubService([]), {});
    await expect(launcher.resolve("claude:nope", "resume")).rejects.toBeInstanceOf(VaultLaunchError);
    await expect(launcher.resolve("claude:nope", "resume")).rejects.toMatchObject({ code: "unknown-entry" });
  });
});
