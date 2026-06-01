// src/session/resolveClaudeSession.test.ts — Unit tests for terminal→session mapping.

import { describe, expect, it, vi } from "vitest";
import type { RunningClaudeSession } from "../vault/readers/runningSessions";
import { resolveClaudeSession, type ResolveClaudeSessionDeps } from "./resolveClaudeSession";

const TID = "term-1";

function run(sessionId: string, pid: number, cwd: string): RunningClaudeSession {
  return { sessionId, pid, cwd };
}

function makeDeps(overrides: Partial<ResolveClaudeSessionDeps> = {}): ResolveClaudeSessionDeps {
  return {
    getPtyPid: vi.fn(() => 1000),
    getCwd: vi.fn(async () => "/work/proj"),
    listRunning: vi.fn(async () => []),
    descendantPids: vi.fn(async () => []),
    sessionMtime: vi.fn(async () => 0),
    newestSessionUnderCwd: vi.fn(async () => null),
    ...overrides,
  };
}

describe("resolveClaudeSession — step 1 (process subtree ∩ registry)", () => {
  it("returns the exact session when one running pid is in the pty subtree", async () => {
    const deps = makeDeps({
      descendantPids: vi.fn(async () => [1001, 1002]),
      listRunning: vi.fn(async () => [run("sess-x", 1002, "/launch/cwd"), run("sess-y", 5000, "/other")]),
    });
    expect(await resolveClaudeSession(TID, deps)).toEqual({ sessionId: "sess-x", cwd: "/launch/cwd" });
    // An exact subtree hit must NOT consult the cwd fallbacks.
    expect(deps.getCwd).not.toHaveBeenCalled();
  });

  it("tie-breaks >1 subtree matches by newest <sessionId>.jsonl mtime", async () => {
    const deps = makeDeps({
      descendantPids: vi.fn(async () => [1001, 1002]),
      listRunning: vi.fn(async () => [run("old", 1001, "/a"), run("new", 1002, "/b")]),
      sessionMtime: vi.fn(async (id: string) => (id === "new" ? 200 : 100)),
    });
    expect(await resolveClaudeSession(TID, deps)).toEqual({ sessionId: "new", cwd: "/b" });
  });
});

describe("resolveClaudeSession — step 2 (running by cwd)", () => {
  it("falls back to a running entry whose cwd matches the pane cwd", async () => {
    const deps = makeDeps({
      getPtyPid: vi.fn(() => 1000),
      descendantPids: vi.fn(async () => [9999]), // no registry pid in subtree
      getCwd: vi.fn(async () => "/work/proj"),
      listRunning: vi.fn(async () => [run("sess-here", 4242, "/work/proj"), run("elsewhere", 4243, "/other")]),
    });
    expect(await resolveClaudeSession(TID, deps)).toEqual({ sessionId: "sess-here", cwd: "/work/proj" });
  });

  it("tie-breaks multiple cwd matches by newest mtime", async () => {
    const deps = makeDeps({
      descendantPids: vi.fn(async () => []),
      getCwd: vi.fn(async () => "/work/proj"),
      listRunning: vi.fn(async () => [run("a", 1, "/work/proj"), run("b", 2, "/work/proj")]),
      sessionMtime: vi.fn(async (id: string) => (id === "b" ? 9 : 1)),
    });
    expect(await resolveClaudeSession(TID, deps)).toEqual({ sessionId: "b", cwd: "/work/proj" });
  });
});

describe("resolveClaudeSession — step 3 (newest under cwd) + null", () => {
  it("falls back to the newest session under cwd when no running entry matches", async () => {
    const deps = makeDeps({
      descendantPids: vi.fn(async () => []),
      getCwd: vi.fn(async () => "/work/proj"),
      listRunning: vi.fn(async () => [run("running-elsewhere", 1, "/elsewhere")]),
      newestSessionUnderCwd: vi.fn(async () => ({ sessionId: "exited", cwd: "/work/proj" })),
    });
    expect(await resolveClaudeSession(TID, deps)).toEqual({ sessionId: "exited", cwd: "/work/proj" });
  });

  it("returns null when nothing resolves", async () => {
    const deps = makeDeps({
      descendantPids: vi.fn(async () => []),
      getCwd: vi.fn(async () => "/work/proj"),
      newestSessionUnderCwd: vi.fn(async () => null),
    });
    expect(await resolveClaudeSession(TID, deps)).toBeNull();
  });

  it("returns null when the pane has no cwd and no subtree match", async () => {
    const deps = makeDeps({
      getPtyPid: vi.fn(() => undefined), // unknown pane
      getCwd: vi.fn(async () => undefined),
    });
    expect(await resolveClaudeSession(TID, deps)).toBeNull();
    expect(deps.newestSessionUnderCwd).not.toHaveBeenCalled();
  });
});

describe("resolveClaudeSession — Windows / no pty pid", () => {
  it("uses cwd fallbacks when descendantPids returns [] (Windows no-op)", async () => {
    const deps = makeDeps({
      getPtyPid: vi.fn(() => 1000),
      descendantPids: vi.fn(async () => []), // Windows: empty subtree
      getCwd: vi.fn(async () => "/work/proj"),
      listRunning: vi.fn(async () => [run("by-cwd", 7, "/work/proj")]),
    });
    expect(await resolveClaudeSession(TID, deps)).toEqual({ sessionId: "by-cwd", cwd: "/work/proj" });
  });
});
