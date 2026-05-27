// Grace-period destroy + cancel + sync-flush on dispose.
// See: asimov/changes/restore-terminal-sessions/design.md D3.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import type { MessageSender } from "./OutputBuffer";

vi.mock("../pty/processCwd", () => ({ queryProcessCwd: vi.fn(async () => undefined) }));
vi.mock("../pty/PtyManager", () => ({
  loadNodePty: vi.fn(() => ({ spawn: vi.fn() })),
  detectShell: vi.fn(() => ({ shell: "/bin/zsh", args: ["--login"] })),
  buildEnvironment: vi.fn(() => ({ PATH: "/usr/bin" })),
  resolveWorkingDirectory: vi.fn(() => "/tmp"),
}));
vi.mock("../pty/PtySession", () => {
  class MockPtySession {
    id: string;
    pid = 99000;
    spawn = vi.fn();
    write = vi.fn();
    resize = vi.fn();
    kill = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    setShellIntegrationSink = vi.fn();
    setShellIntegrationNonce = vi.fn();
    onData: any = undefined;
    onExit: any = undefined;
    constructor(id: string) {
      this.id = id;
    }
  }
  return { PtySession: MockPtySession };
});
vi.mock("./OutputBuffer", () => {
  class MockOutputBuffer {
    append = vi.fn();
    dispose = vi.fn();
    updateWebview = vi.fn();
    pauseOutput = vi.fn();
    resumeOutput = vi.fn();
    handleAck = vi.fn();
    flush = vi.fn();
    bufferSize = 0;
    unackedCharCount = 0;
    constructor(
      public _i: string,
      public _w: unknown,
      public _p: unknown,
    ) {}
  }
  return { OutputBuffer: MockOutputBuffer };
});

import { SessionManager } from "./SessionManager";

function mockWebview(): MessageSender {
  return { postMessage: vi.fn(() => Promise.resolve(true)) };
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionManager.scheduleDestroyForView", () => {
  it("fires destroyAllForView after the configured delay", async () => {
    const sm = new SessionManager();
    const w = mockWebview();
    sm.createSession("editor-P1", w);
    const spy = vi.spyOn(sm, "destroyAllForView");

    sm.scheduleDestroyForView("editor-P1", 1000);
    expect(sm.getPendingDestroyViewIds()).toEqual(["editor-P1"]);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledWith("editor-P1");
    expect(sm.getPendingDestroyViewIds()).toEqual([]);

    sm.dispose();
  });

  it("cancelScheduledDestroy prevents the destroy from firing", async () => {
    const sm = new SessionManager();
    const w = mockWebview();
    sm.createSession("editor-P1", w);
    const spy = vi.spyOn(sm, "destroyAllForView");
    sm.scheduleDestroyForView("editor-P1", 1000);
    sm.cancelScheduledDestroy("editor-P1");
    expect(sm.getPendingDestroyViewIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spy).not.toHaveBeenCalled();
    sm.dispose();
  });

  it("re-scheduling the same viewId overwrites the prior timer", async () => {
    const sm = new SessionManager();
    const w = mockWebview();
    sm.createSession("editor-P1", w);
    const spy = vi.spyOn(sm, "destroyAllForView");
    sm.scheduleDestroyForView("editor-P1", 100);
    sm.scheduleDestroyForView("editor-P1", 1000); // overwrite
    await vi.advanceTimersByTimeAsync(200);
    expect(spy).not.toHaveBeenCalled(); // first timer was cleared
    await vi.advanceTimersByTimeAsync(900);
    expect(spy).toHaveBeenCalledTimes(1);
    sm.dispose();
  });

  it("dispose() synchronously tears down every session, clearing pending timers", () => {
    // Behavioral invariant per spec "Synchronous cleanup of pending destroys":
    // no PTY survives dispose, regardless of grace-period timers in flight.
    // Earlier rounds asserted the implementation (destroyAllForView called); the
    // sync dispose path bypasses the operation queue entirely (round-1 W3), so
    // we now assert the observable outcome instead.
    const sm = new SessionManager();
    const w = mockWebview();
    const sid1 = sm.createSession("editor-P1", w);
    const sid2 = sm.createSession("editor-P2", w);
    sm.scheduleDestroyForView("editor-P1", 5000);
    sm.scheduleDestroyForView("editor-P2", 5000);
    expect(sm.getPendingDestroyViewIds().sort()).toEqual(["editor-P1", "editor-P2"]);

    sm.dispose();
    // Sessions gone, pending timers cleared.
    expect(sm.getSession(sid1)).toBeUndefined();
    expect(sm.getSession(sid2)).toBeUndefined();
    expect(sm.getPendingDestroyViewIds()).toEqual([]);
  });
});
