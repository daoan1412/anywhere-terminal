// src/session/SessionManager.test.ts — Unit tests for SessionManager
// See: specs/session-manager-core/spec.md, specs/session-manager-lifecycle/spec.md, specs/session-manager-numbering/spec.md

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import type { MessageSender } from "./OutputBuffer";

// ─── Mocks ──────────────────────────────────────────────────────────

// Track mock PtySession instances for assertions
const mockPtySessions: Array<{
  id: string;
  spawn: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setCurrentCwdSink: ReturnType<typeof vi.fn>;
  cwdSink: ((cwd: string) => void) | undefined;
  onData: ((data: string) => void) | undefined;
  onExit: ((code: number) => void) | undefined;
}> = [];

vi.mock("../pty/processCwd", () => ({
  queryProcessCwd: vi.fn(async (_pid: number) => undefined as string | undefined),
}));

vi.mock("../pty/PtyManager", () => ({
  loadNodePty: vi.fn(() => ({
    spawn: vi.fn(() => ({
      onData: vi.fn(() => ({ dispose: () => {} })),
      onExit: vi.fn(() => ({ dispose: () => {} })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pid: 12345,
    })),
  })),
  detectShell: vi.fn(() => ({ shell: "/bin/zsh", args: ["--login"] })),
  buildEnvironment: vi.fn(() => ({ PATH: "/usr/bin" })),
  resolveWorkingDirectory: vi.fn(() => "/tmp"),
}));

vi.mock("../pty/PtySession", () => {
  class MockPtySession {
    id: string;
    pid = 99000; // stable fake pid for getLiveCwd tests
    spawn = vi.fn();
    write = vi.fn();
    resize = vi.fn();
    kill = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    setCurrentCwdSink = vi.fn((fn: ((cwd: string) => void) | undefined) => {
      const tracked = mockPtySessions.find((p) => p.id === this.id);
      if (tracked) {
        tracked.cwdSink = fn;
      }
    });
    setShellIntegrationSink = vi.fn();
    setShellIntegrationNonce = vi.fn();
    private _onDataCallback: ((data: string) => void) | undefined;
    private _onExitCallback: ((code: number) => void) | undefined;

    get onData(): ((data: string) => void) | undefined {
      return this._onDataCallback;
    }
    set onData(cb: ((data: string) => void) | undefined) {
      this._onDataCallback = cb;
      // Update the tracked instance
      const tracked = mockPtySessions.find((p) => p.id === this.id);
      if (tracked) {
        tracked.onData = cb;
      }
    }

    get onExit(): ((code: number) => void) | undefined {
      return this._onExitCallback;
    }
    set onExit(cb: ((code: number) => void) | undefined) {
      this._onExitCallback = cb;
      const tracked = mockPtySessions.find((p) => p.id === this.id);
      if (tracked) {
        tracked.onExit = cb;
      }
    }

    constructor(id: string) {
      this.id = id;
      mockPtySessions.push({
        id,
        spawn: this.spawn,
        write: this.write,
        resize: this.resize,
        kill: this.kill,
        setCurrentCwdSink: this.setCurrentCwdSink,
        cwdSink: undefined,
        onData: undefined,
        onExit: undefined,
      });
    }
  }
  return { PtySession: MockPtySession };
});

vi.mock("./OutputBuffer", () => {
  class MockOutputBuffer {
    append = vi.fn();
    handleAck = vi.fn();
    dispose = vi.fn();
    flush = vi.fn();
    pauseOutput = vi.fn();
    resumeOutput = vi.fn();
    updateWebview = vi.fn();
    /** Mock bufferSize — settable for testing getMemoryMetrics(). */
    private _mockBufferSize = 0;
    get bufferSize(): number {
      return this._mockBufferSize;
    }
    set bufferSize(value: number) {
      this._mockBufferSize = value;
    }
    /** Mock unackedCharCount — settable for testing getMemoryMetrics(). */
    private _mockUnackedCharCount = 0;
    get unackedCharCount(): number {
      return this._mockUnackedCharCount;
    }
    set unackedCharCount(value: number) {
      this._mockUnackedCharCount = value;
    }
    constructor(
      public _tabId: string,
      public _webview: unknown,
      public _pty: unknown,
    ) {}
  }
  return { OutputBuffer: MockOutputBuffer };
});

import { SessionManager } from "./SessionManager";

// ─── Test Setup ─────────────────────────────────────────────────────

function createMockWebview(): MessageSender & { messages: unknown[] } {
  return {
    messages: [],
    postMessage(message: unknown): Thenable<boolean> {
      this.messages.push(message);
      return Promise.resolve(true);
    },
  };
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
  mockPtySessions.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Session CRUD ───────────────────────────────────────────────────

describe("SessionManager: createSession", () => {
  it("creates a session and returns a UUID", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview);

    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    sm.dispose();
  });

  it("populates all maps on creation", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview);

    // Session exists
    const session = sm.getSession(id);
    expect(session).toBeDefined();
    expect(session!.viewId).toBe("anywhereTerminal.sidebar");
    expect(session!.id).toBe(id);

    // Tabs for view
    const tabs = sm.getTabsForView("anywhereTerminal.sidebar");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(id);

    sm.dispose();
  });

  it("first session in a view is automatically active", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview);
    const session = sm.getSession(id);

    expect(session!.isActive).toBe(true);

    sm.dispose();
  });

  it("subsequent sessions in a view are active, previous deactivated", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("anywhereTerminal.sidebar", webview);
    const id2 = sm.createSession("anywhereTerminal.sidebar", webview);

    expect(sm.getSession(id1)!.isActive).toBe(false);
    expect(sm.getSession(id2)!.isActive).toBe(true);

    sm.dispose();
  });

  it("assigns name based on terminal number", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("anywhereTerminal.sidebar", webview);
    const id2 = sm.createSession("anywhereTerminal.sidebar", webview);

    expect(sm.getSession(id1)!.name).toBe("Terminal 1");
    expect(sm.getSession(id2)!.name).toBe("Terminal 2");

    sm.dispose();
  });

  it("spawns a PtySession", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    sm.createSession("anywhereTerminal.sidebar", webview);

    expect(mockPtySessions).toHaveLength(1);
    expect(mockPtySessions[0].spawn).toHaveBeenCalled();

    sm.dispose();
  });

  it("prefers persisted shell, args, and cwd when restoring from a snapshot", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview, {
      shell: "/current/settings-shell",
      shellArgs: ["--current"],
      cwd: "/current/settings-cwd",
      restoreFrom: {
        metadata: {
          sessionId: "RESTORED-SHELL-CWD",
          viewLocation: "sidebar",
          terminalNumber: 7,
          customName: null,
          shell: "/persisted/shell",
          shellArgs: ["--persisted"],
          cwd: "/persisted/cwd",
          currentCwd: "/persisted/current-cwd",
          cols: 80,
          rows: 24,
          bufferFile: "snapshots/RESTORED-SHELL-CWD.snapshot.ans",
          bufferBytes: 3,
          isSplitPane: false,
          rootTabId: "RESTORED-SHELL-CWD",
          snapshotAt: 1700000000000,
          shellExited: false,
          exitCode: null,
        },
        buffer: "BUF",
      },
    });

    expect(id).toBe("RESTORED-SHELL-CWD");
    expect(mockPtySessions[0].spawn).toHaveBeenCalledWith(
      expect.anything(),
      "/persisted/shell",
      ["--persisted"],
      expect.objectContaining({ cwd: "/persisted/cwd" }),
    );
    expect(sm.getCurrentCwd(id)).toBe("/persisted/current-cwd");

    sm.dispose();
  });
});

// ─── getInitialCwd ──────────────────────────────────────────────────

describe("SessionManager: getInitialCwd", () => {
  it("returns the explicit cwd passed to createSession", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview, { cwd: "/explicit/path" });

    expect(sm.getInitialCwd(id)).toBe("/explicit/path");

    sm.dispose();
  });

  it("returns the resolved fallback when no cwd is passed", () => {
    // PtyManager.resolveWorkingDirectory() is mocked to "/tmp"
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview);

    expect(sm.getInitialCwd(id)).toBe("/tmp");

    sm.dispose();
  });

  it("returns undefined for an unknown session id", () => {
    const sm = new SessionManager();

    expect(sm.getInitialCwd("does-not-exist")).toBeUndefined();

    sm.dispose();
  });
});

// ─── getCurrentCwd / setCurrentCwd ──────────────────────────────────

describe("SessionManager: getCurrentCwd", () => {
  it("returns undefined when never set", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);

    expect(sm.getCurrentCwd(id)).toBeUndefined();

    sm.dispose();
  });

  it("returns the value after setCurrentCwd", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    sm.setCurrentCwd(id, "/some/path");

    expect(sm.getCurrentCwd(id)).toBe("/some/path");

    sm.dispose();
  });

  it("returns the latest value after multiple sets", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    sm.setCurrentCwd(id, "/first");
    sm.setCurrentCwd(id, "/second");
    sm.setCurrentCwd(id, "/third");

    expect(sm.getCurrentCwd(id)).toBe("/third");

    sm.dispose();
  });

  it("returns undefined for an unknown sessionId", () => {
    const sm = new SessionManager();

    expect(sm.getCurrentCwd("does-not-exist")).toBeUndefined();

    sm.dispose();
  });

  it("setCurrentCwd silently no-ops for an unknown sessionId", () => {
    const sm = new SessionManager();

    expect(() => sm.setCurrentCwd("does-not-exist", "/x")).not.toThrow();
    expect(sm.getCurrentCwd("does-not-exist")).toBeUndefined();

    sm.dispose();
  });

  it("getLiveCwd returns undefined for an unknown session", async () => {
    const sm = new SessionManager();
    expect(await sm.getLiveCwd("does-not-exist")).toBeUndefined();
    sm.dispose();
  });

  it("getLiveCwd calls queryProcessCwd with the session's pty pid and returns the result", async () => {
    const { queryProcessCwd } = await import("../pty/processCwd.js");
    (queryProcessCwd as ReturnType<typeof vi.fn>).mockResolvedValueOnce("/live/cwd");
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    const result = await sm.getLiveCwd(id);
    expect(result).toBe("/live/cwd");
    expect(queryProcessCwd).toHaveBeenCalledWith(99000);
    sm.dispose();
  });

  it("getLiveCwd returns undefined when queryProcessCwd resolves undefined (process gone)", async () => {
    const { queryProcessCwd } = await import("../pty/processCwd.js");
    (queryProcessCwd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    expect(await sm.getLiveCwd(id)).toBeUndefined();
    sm.dispose();
  });

  it("registers a sink with PtySession that routes parsed cwds back via setCurrentCwd", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const tracked = mockPtySessions.find((p) => p.id === id);
    expect(tracked).toBeDefined();
    expect(tracked!.setCurrentCwdSink).toHaveBeenCalledTimes(1);
    expect(tracked!.cwdSink).toBeDefined();

    // Simulate the parser firing — should land in the session's currentCwd.
    tracked!.cwdSink!("/tmp/foo");
    expect(sm.getCurrentCwd(id)).toBe("/tmp/foo");

    // Subsequent emits replace the previous value.
    tracked!.cwdSink!("/tmp/bar");
    expect(sm.getCurrentCwd(id)).toBe("/tmp/bar");

    sm.dispose();
  });
});

// ─── writeToSession ─────────────────────────────────────────────────

describe("SessionManager: writeToSession", () => {
  it("forwards data to the session's PTY", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview);
    sm.writeToSession(id, "ls\r");

    const ptyMock = mockPtySessions.find((p) => p.id === id);
    expect(ptyMock!.write).toHaveBeenCalledWith("ls\r");

    sm.dispose();
  });

  it("silently ignores unknown session IDs", () => {
    const sm = new SessionManager();

    expect(() => sm.writeToSession("nonexistent", "data")).not.toThrow();

    sm.dispose();
  });
});

// ─── resizeSession ──────────────────────────────────────────────────

describe("SessionManager: resizeSession", () => {
  it("resizes the PTY and updates session dimensions", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("anywhereTerminal.sidebar", webview);
    sm.resizeSession(id, 120, 40);

    const ptyMock = mockPtySessions.find((p) => p.id === id);
    expect(ptyMock!.resize).toHaveBeenCalledWith(120, 40);

    const session = sm.getSession(id);
    expect(session!.cols).toBe(120);
    expect(session!.rows).toBe(40);

    sm.dispose();
  });

  it("silently ignores unknown session IDs", () => {
    const sm = new SessionManager();

    expect(() => sm.resizeSession("nonexistent", 80, 24)).not.toThrow();

    sm.dispose();
  });
});

// ─── switchActiveSession ────────────────────────────────────────────

describe("SessionManager: switchActiveSession", () => {
  it("switches active session in a view", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    // id2 is active after creation
    expect(sm.getSession(id2)!.isActive).toBe(true);
    expect(sm.getSession(id1)!.isActive).toBe(false);

    // Switch to id1
    sm.switchActiveSession("sidebar", id1);

    expect(sm.getSession(id1)!.isActive).toBe(true);
    expect(sm.getSession(id2)!.isActive).toBe(false);

    sm.dispose();
  });

  it("silently ignores unknown viewId", () => {
    const sm = new SessionManager();

    expect(() => sm.switchActiveSession("nonexistent", "s1")).not.toThrow();

    sm.dispose();
  });

  it("silently ignores unknown sessionId within a valid view", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);

    // Try to switch to a non-existent session
    sm.switchActiveSession("sidebar", "nonexistent");

    // Original session should still be active
    expect(sm.getSession(id1)!.isActive).toBe(true);

    sm.dispose();
  });
});

// ─── getTabsForView ─────────────────────────────────────────────────

describe("SessionManager: getTabsForView", () => {
  it("returns ordered session info", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    sm.createSession("sidebar", webview);

    // Switch back to id1 to test isActive
    sm.switchActiveSession("sidebar", id1);

    const tabs = sm.getTabsForView("sidebar");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].name).toBe("Terminal 1");
    expect(tabs[0].isActive).toBe(true);
    expect(tabs[1].name).toBe("Terminal 2");
    expect(tabs[1].isActive).toBe(false);

    sm.dispose();
  });

  it("returns empty array for unknown viewId", () => {
    const sm = new SessionManager();

    expect(sm.getTabsForView("nonexistent")).toEqual([]);

    sm.dispose();
  });
});

// ─── isSplitPane ────────────────────────────────────────────────────

describe("SessionManager: isSplitPane", () => {
  it("defaults isSplitPane to false", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const session = sm.getSession(id);

    expect(session!.isSplitPane).toBe(false);

    sm.dispose();
  });

  it("marks session as split pane when isSplitPane option is true", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview, { isSplitPane: true });
    const session = sm.getSession(id);

    expect(session!.isSplitPane).toBe(true);

    sm.dispose();
  });

  it("excludes split pane sessions from getTabsForView", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const rootId = sm.createSession("sidebar", webview);
    sm.createSession("sidebar", webview, { isSplitPane: true });
    sm.createSession("sidebar", webview, { isSplitPane: true });

    const tabs = sm.getTabsForView("sidebar");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe(rootId);

    sm.dispose();
  });

  it("split pane creation does NOT deactivate the root tab", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const rootId = sm.createSession("sidebar", webview);
    expect(sm.getSession(rootId)!.isActive).toBe(true);

    // Create split pane — should NOT deactivate root
    const splitId = sm.createSession("sidebar", webview, { isSplitPane: true });
    expect(sm.getSession(rootId)!.isActive).toBe(true);
    expect(sm.getSession(splitId)!.isActive).toBe(false);

    sm.dispose();
  });

  it("split pane session is still accessible via getSession", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const splitId = sm.createSession("sidebar", webview, { isSplitPane: true });
    const session = sm.getSession(splitId);

    expect(session).toBeDefined();
    expect(session!.isSplitPane).toBe(true);

    sm.dispose();
  });
});

// ─── getSession ─────────────────────────────────────────────────────

describe("SessionManager: getSession", () => {
  it("returns the session for a valid ID", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const session = sm.getSession(id);

    expect(session).toBeDefined();
    expect(session!.id).toBe(id);

    sm.dispose();
  });

  it("returns undefined for unknown ID", () => {
    const sm = new SessionManager();

    expect(sm.getSession("nonexistent")).toBeUndefined();

    sm.dispose();
  });
});

// ─── clearScrollback ────────────────────────────────────────────────

describe("SessionManager: clearScrollback", () => {
  it("clears the scrollback cache", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);

    // Simulate data arriving (triggers scrollback append via onData)
    const ptyMock = mockPtySessions.find((p) => p.id === id);
    ptyMock!.onData?.("some output data");

    const session = sm.getSession(id);
    expect(session!.scrollbackCache.length).toBeGreaterThan(0);

    sm.clearScrollback(id);

    expect(session!.scrollbackCache).toEqual([]);
    expect(session!.scrollbackSize).toBe(0);

    sm.dispose();
  });

  it("silently ignores unknown session IDs", () => {
    const sm = new SessionManager();

    expect(() => sm.clearScrollback("nonexistent")).not.toThrow();

    sm.dispose();
  });
});

// ─── Terminal Number Recycling ──────────────────────────────────────

describe("SessionManager: number recycling", () => {
  it("assigns sequential numbers starting from 1", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);
    const id3 = sm.createSession("sidebar", webview);

    expect(sm.getSession(id1)!.number).toBe(1);
    expect(sm.getSession(id2)!.number).toBe(2);
    expect(sm.getSession(id3)!.number).toBe(3);

    sm.dispose();
  });

  it("fills gaps after deletion", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);
    const id3 = sm.createSession("sidebar", webview);

    // Destroy session 2
    sm.destroySession(id2);

    // Wait for operation queue to process
    await vi.advanceTimersByTimeAsync(100);

    // Create a new session — should get number 2 (gap-filling)
    const id4 = sm.createSession("sidebar", webview);

    expect(sm.getSession(id1)!.number).toBe(1);
    expect(sm.getSession(id3)!.number).toBe(3);
    expect(sm.getSession(id4)!.number).toBe(2);
    expect(sm.getSession(id4)!.name).toBe("Terminal 2");

    sm.dispose();
  });

  it("numbers always start from 1", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);

    expect(sm.getSession(id)!.number).toBe(1);

    sm.dispose();
  });
});

// ─── Scrollback Cache ───────────────────────────────────────────────

describe("SessionManager: scrollback cache", () => {
  it("appends data to scrollback cache via onData", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const ptyMock = mockPtySessions.find((p) => p.id === id);

    // Simulate PTY output
    ptyMock!.onData?.("hello ");
    ptyMock!.onData?.("world");

    const session = sm.getSession(id);
    expect(session!.scrollbackCache).toEqual(["hello ", "world"]);
    expect(session!.scrollbackSize).toBe(11);

    sm.dispose();
  });

  it("evicts old data when exceeding max size", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const ptyMock = mockPtySessions.find((p) => p.id === id);

    // Fill cache to near max (512KB = 524,288 bytes)
    const chunk520k = "x".repeat(520_000);
    ptyMock!.onData?.(chunk520k);

    const session = sm.getSession(id);
    expect(session!.scrollbackSize).toBe(520_000);

    // Add 10KB more — total 530KB > 524,288 → should evict the 520KB chunk
    const chunk10k = "y".repeat(10_000);
    ptyMock!.onData?.(chunk10k);

    // After eviction, only the 10KB chunk should remain
    expect(session!.scrollbackSize).toBe(10_000);
    expect(session!.scrollbackCache).toEqual([chunk10k]);

    sm.dispose();
  });
});

// ─── Destroy Operations ─────────────────────────────────────────────

describe("SessionManager: destroySession", () => {
  it("removes session from all maps", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    expect(sm.getSession(id)).toBeDefined();

    sm.destroySession(id);
    await vi.advanceTimersByTimeAsync(100);

    expect(sm.getSession(id)).toBeUndefined();
    expect(sm.getTabsForView("sidebar")).toEqual([]);

    sm.dispose();
  });

  it("is a no-op for non-existent sessions", async () => {
    const sm = new SessionManager();

    sm.destroySession("nonexistent");
    await vi.advanceTimersByTimeAsync(100);

    // Should not throw
    sm.dispose();
  });

  it("kills the PTY process", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const ptyMock = mockPtySessions.find((p) => p.id === id);

    sm.destroySession(id);
    await vi.advanceTimersByTimeAsync(100);

    expect(ptyMock!.kill).toHaveBeenCalled();

    sm.dispose();
  });
});

describe("SessionManager: destroyAllForView", () => {
  it("destroys all sessions for a view", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    sm.destroyAllForView("sidebar");
    await vi.advanceTimersByTimeAsync(100);

    expect(sm.getSession(id1)).toBeUndefined();
    expect(sm.getSession(id2)).toBeUndefined();
    expect(sm.getTabsForView("sidebar")).toEqual([]);

    sm.dispose();
  });

  it("is a no-op for unknown viewId", async () => {
    const sm = new SessionManager();

    sm.destroyAllForView("nonexistent");
    await vi.advanceTimersByTimeAsync(100);

    // Should not throw
    sm.dispose();
  });
});

// ─── Operation Queue Serialization ──────────────────────────────────

describe("SessionManager: operation queue", () => {
  it("serializes rapid destroy calls", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    // Rapid destroy calls
    sm.destroySession(id1);
    sm.destroySession(id2);

    await vi.advanceTimersByTimeAsync(200);

    expect(sm.getSession(id1)).toBeUndefined();
    expect(sm.getSession(id2)).toBeUndefined();

    sm.dispose();
  });

  it("continues processing after an error in a destroy operation", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    // Make the first PTY kill throw
    const ptyMock1 = mockPtySessions.find((p) => p.id === id1);
    ptyMock1!.kill.mockImplementation(() => {
      throw new Error("Kill failed");
    });

    sm.destroySession(id1);
    sm.destroySession(id2);

    await vi.advanceTimersByTimeAsync(200);

    // Second session should still be destroyed despite first error
    expect(sm.getSession(id2)).toBeUndefined();

    sm.dispose();
  });
});

// ─── Kill Tracking ──────────────────────────────────────────────────

describe("SessionManager: kill tracking", () => {
  it("intentional kill prevents double cleanup via onExit", async () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const ptyMock = mockPtySessions.find((p) => p.id === id);

    // Start destroy
    sm.destroySession(id);

    // Simulate onExit firing during destroy (before queue completes)
    // The onExit handler should check terminalBeingKilled and skip cleanup
    ptyMock!.onExit?.(0);

    await vi.advanceTimersByTimeAsync(100);

    // Session should be cleaned up exactly once
    expect(sm.getSession(id)).toBeUndefined();

    sm.dispose();
  });

  it("unexpected PTY crash triggers cleanup and sends exit message", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const ptyMock = mockPtySessions.find((p) => p.id === id);

    // Simulate unexpected crash (not via destroySession)
    ptyMock!.onExit?.(1);

    // Session should be cleaned up
    expect(sm.getSession(id)).toBeUndefined();

    // Exit message should be sent to webview
    expect(webview.messages).toContainEqual(
      expect.objectContaining({
        type: "exit",
        tabId: id,
        code: 1,
      }),
    );

    sm.dispose();
  });
});

// ─── Dispose ────────────────────────────────────────────────────────

describe("SessionManager: dispose", () => {
  it("kills all PTY processes and clears all maps", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("panel", webview);

    sm.dispose();

    expect(sm.getSession(id1)).toBeUndefined();
    expect(sm.getSession(id2)).toBeUndefined();
    expect(sm.getTabsForView("sidebar")).toEqual([]);
    expect(sm.getTabsForView("panel")).toEqual([]);
  });

  it("is idempotent (second dispose is no-op)", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    sm.createSession("sidebar", webview);

    sm.dispose();
    expect(() => sm.dispose()).not.toThrow();
  });

  it("kills PTY processes for all sessions", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    sm.createSession("sidebar", webview);
    sm.createSession("panel", webview);

    sm.dispose();

    for (const ptyMock of mockPtySessions) {
      expect(ptyMock.kill).toHaveBeenCalled();
    }
  });
});

// ─── handleAck ──────────────────────────────────────────────────────

describe("SessionManager: handleAck", () => {
  it("forwards ack to the session's output buffer", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const session = sm.getSession(id);

    sm.handleAck(id, 5000);

    expect(session!.outputBuffer.handleAck).toHaveBeenCalledWith(5000);

    sm.dispose();
  });

  it("silently ignores unknown session IDs", () => {
    const sm = new SessionManager();

    expect(() => sm.handleAck("nonexistent", 5000)).not.toThrow();

    sm.dispose();
  });
});

// ─── updateWebviewForView ───────────────────────────────────────────

describe("SessionManager: updateWebviewForView", () => {
  it("updates webview reference for all sessions in a view", () => {
    const sm = new SessionManager();
    const webview1 = createMockWebview();
    const webview2 = createMockWebview();

    const id1 = sm.createSession("sidebar", webview1);
    const id2 = sm.createSession("sidebar", webview1);

    sm.updateWebviewForView("sidebar", webview2);

    const session1 = sm.getSession(id1);
    const session2 = sm.getSession(id2);
    expect(session1!.webview).toBe(webview2);
    expect(session2!.webview).toBe(webview2);

    // OutputBuffer.updateWebview should have been called
    expect(session1!.outputBuffer.updateWebview).toHaveBeenCalledWith(webview2);
    expect(session2!.outputBuffer.updateWebview).toHaveBeenCalledWith(webview2);

    sm.dispose();
  });

  it("silently ignores unknown viewId", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    expect(() => sm.updateWebviewForView("nonexistent", webview)).not.toThrow();

    sm.dispose();
  });
});

// ─── getScrollbackData ──────────────────────────────────────────────

describe("SessionManager: getScrollbackData", () => {
  it("returns joined scrollback cache for existing session", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id = sm.createSession("sidebar", webview);
    const ptyMock = mockPtySessions.find((p) => p.id === id);

    // Simulate PTY output
    ptyMock!.onData?.("hello");
    ptyMock!.onData?.(" world");

    expect(sm.getScrollbackData(id)).toBe("hello world");

    sm.dispose();
  });

  it("returns empty string for non-existent session", () => {
    const sm = new SessionManager();

    expect(sm.getScrollbackData("nonexistent")).toBe("");

    sm.dispose();
  });
});

// ─── pauseOutputForView / resumeOutputForView ───────────────────────

describe("SessionManager: pauseOutputForView / resumeOutputForView", () => {
  it("pauses output for all sessions in a view", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    sm.pauseOutputForView("sidebar");

    const session1 = sm.getSession(id1);
    const session2 = sm.getSession(id2);
    expect(session1!.outputBuffer.pauseOutput).toHaveBeenCalled();
    expect(session2!.outputBuffer.pauseOutput).toHaveBeenCalled();

    sm.dispose();
  });

  it("resumes output for all sessions in a view", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    sm.resumeOutputForView("sidebar");

    const session1 = sm.getSession(id1);
    const session2 = sm.getSession(id2);
    expect(session1!.outputBuffer.resumeOutput).toHaveBeenCalled();
    expect(session2!.outputBuffer.resumeOutput).toHaveBeenCalled();

    sm.dispose();
  });

  it("silently ignores unknown viewId for pause", () => {
    const sm = new SessionManager();

    expect(() => sm.pauseOutputForView("nonexistent")).not.toThrow();

    sm.dispose();
  });

  it("silently ignores unknown viewId for resume", () => {
    const sm = new SessionManager();

    expect(() => sm.resumeOutputForView("nonexistent")).not.toThrow();

    sm.dispose();
  });
});

// ─── getMemoryMetrics ───────────────────────────────────────────────

describe("SessionManager: getMemoryMetrics", () => {
  it("returns zeros when no sessions exist", () => {
    const sm = new SessionManager();

    const metrics = sm.getMemoryMetrics();

    expect(metrics.sessionCount).toBe(0);
    expect(metrics.totalBufferSize).toBe(0);
    expect(metrics.totalScrollbackSize).toBe(0);
    expect(metrics.sessions).toEqual([]);

    sm.dispose();
  });

  it("returns correct aggregate and per-session metrics", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();

    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);

    // Set up mock buffer sizes and scrollback
    const session1 = sm.getSession(id1)!;
    const session2 = sm.getSession(id2)!;

    // Set mock values on the output buffers
    (session1.outputBuffer as unknown as { bufferSize: number }).bufferSize = 1000;
    (session1.outputBuffer as unknown as { unackedCharCount: number }).unackedCharCount = 500;
    session1.scrollbackSize = 2000;

    (session2.outputBuffer as unknown as { bufferSize: number }).bufferSize = 3000;
    (session2.outputBuffer as unknown as { unackedCharCount: number }).unackedCharCount = 1500;
    session2.scrollbackSize = 4000;

    const metrics = sm.getMemoryMetrics();

    expect(metrics.sessionCount).toBe(2);
    expect(metrics.totalBufferSize).toBe(4000); // 1000 + 3000
    expect(metrics.totalScrollbackSize).toBe(6000); // 2000 + 4000
    expect(metrics.sessions).toHaveLength(2);

    // Find sessions by ID (order may vary)
    const m1 = metrics.sessions.find((s: { id: string }) => s.id === id1)!;
    const m2 = metrics.sessions.find((s: { id: string }) => s.id === id2)!;

    expect(m1.name).toBe("Terminal 1");
    expect(m1.bufferSize).toBe(1000);
    expect(m1.scrollbackSize).toBe(2000);
    expect(m1.unackedCharCount).toBe(500);

    expect(m2.name).toBe("Terminal 2");
    expect(m2.bufferSize).toBe(3000);
    expect(m2.scrollbackSize).toBe(4000);
    expect(m2.unackedCharCount).toBe(1500);

    sm.dispose();
  });
});

// ─── Tab rename + custom-name persistence ────────────────────────────
// See: asimov/changes/add-tab-rename/specs/tab-rename/spec.md
//      asimov/changes/add-tab-rename/specs/session-manager-core/spec.md
//      design.md D3 (persistence) + D7 (validation) + D9 (async)

/** In-memory Memento fake mirroring `vscode.Memento`. */
function createFakeMemento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  let updateImpl: (key: string, value: unknown) => Thenable<void> = (k, v) => {
    if (v === undefined) {
      store.delete(k);
    } else {
      store.set(k, v);
    }
    return Promise.resolve();
  };
  return {
    get: (key: string) => store.get(key),
    update: (key: string, value: unknown) => updateImpl(key, value),
    /** Test-only: snapshot of the underlying store. */
    _snapshot: () => Object.fromEntries(store),
    /** Test-only: swap the update implementation (e.g. to throw). */
    _setUpdate: (impl: (key: string, value: unknown) => Thenable<void>) => {
      updateImpl = impl;
    },
  };
}

const STORAGE_KEY = "anywhereTerminal.tabCustomNames";

describe("SessionManager: customName field default", () => {
  it("defaults to null on createSession for a fresh root tab", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    expect(sm.getSession(id)!.customName).toBeNull();
    sm.dispose();
  });
});

describe("SessionManager.renameSession: normalization", () => {
  it("treats null input as a reset (customName becomes null)", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    sm.renameSession(id, "build");
    expect(sm.getSession(id)!.customName).toBe("build");
    sm.renameSession(id, null);
    expect(sm.getSession(id)!.customName).toBeNull();
    sm.dispose();
  });

  it("treats whitespace-only input as a reset", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    sm.renameSession(id, "build");
    sm.renameSession(id, "   \t  ");
    expect(sm.getSession(id)!.customName).toBeNull();
    sm.dispose();
  });

  it("trims leading/trailing whitespace", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    sm.renameSession(id, "   deploy  ");
    expect(sm.getSession(id)!.customName).toBe("deploy");
    sm.dispose();
  });

  it("silently truncates input longer than 80 characters", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    const long = "x".repeat(120);
    sm.renameSession(id, long);
    const value = sm.getSession(id)!.customName!;
    expect(value.length).toBe(80);
    expect(value).toBe("x".repeat(80));
    sm.dispose();
  });
});

describe("SessionManager.renameSession: side effects", () => {
  it("broadcasts tabRenamed with the normalized customName", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    webview.messages.length = 0; // clear messages from session creation
    sm.renameSession(id, "  build  ");
    const renamed = webview.messages.find(
      (m): m is { type: "tabRenamed"; tabId: string; customName: string | null } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "tabRenamed",
    );
    expect(renamed).toBeDefined();
    expect(renamed!.tabId).toBe(id);
    expect(renamed!.customName).toBe("build");
    sm.dispose();
  });

  it("is a silent no-op on an unknown sessionId (no throw, no broadcast)", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    sm.createSession("sidebar", webview);
    webview.messages.length = 0;
    expect(() => sm.renameSession("never-existed", "x")).not.toThrow();
    expect(webview.messages.find((m) => (m as { type?: string }).type === "tabRenamed")).toBeUndefined();
    sm.dispose();
  });

  it("is a silent no-op when target is a split-pane session", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    sm.createSession("sidebar", webview); // root tab
    const paneId = sm.createSession("sidebar", webview, { isSplitPane: true });
    webview.messages.length = 0;
    sm.renameSession(paneId, "should-not-apply");
    expect(sm.getSession(paneId)!.customName).toBeNull();
    expect(webview.messages.find((m) => (m as { type?: string }).type === "tabRenamed")).toBeUndefined();
    sm.dispose();
  });
});

describe("SessionManager.renameSession: persistence", () => {
  it("upserts the normalized value into workspaceState keyed by terminal number", () => {
    const memento = createFakeMemento();
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview); // number = 1
    sm.renameSession(id, "build");
    expect(memento._snapshot()[STORAGE_KEY]).toEqual({ "1": "build" });
    sm.dispose();
  });

  it("deletes the entry when normalized value is null (reset)", () => {
    const memento = createFakeMemento({ [STORAGE_KEY]: { "1": "build" } });
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview); // number = 1
    // Hydrated on create:
    expect(sm.getSession(id)!.customName).toBe("build");
    sm.renameSession(id, null);
    expect(memento._snapshot()[STORAGE_KEY]).toEqual({});
    sm.dispose();
  });

  it("does NOT persist for a split-pane session", () => {
    const memento = createFakeMemento();
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    sm.createSession("sidebar", webview);
    const paneId = sm.createSession("sidebar", webview, { isSplitPane: true });
    sm.renameSession(paneId, "ignored");
    expect(memento._snapshot()[STORAGE_KEY]).toBeUndefined();
    sm.dispose();
  });

  it("two quick renames of different tabs both persist (regression: B1 race)", async () => {
    // Mock storage with manually-resolved updates so we can replay the race.
    const store = new Map<string, unknown>();
    const pendingUpdates: Array<() => void> = [];
    const memento = {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown) => {
        // Defer the actual apply until we manually drain — mimics two updates
        // queued before the first applies (the failure mode from B1).
        return new Promise<void>((resolve) => {
          pendingUpdates.push(() => {
            store.set(key, value);
            resolve();
          });
        });
      },
    };
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    const idA = sm.createSession("sidebar", webview); // number 1
    const idB = sm.createSession("sidebar", webview); // number 2

    // Two renames in quick succession; both update()s queue before either applies.
    sm.renameSession(idA, "A");
    sm.renameSession(idB, "B");

    // Drain queued updates in order.
    for (const apply of pendingUpdates) {
      apply();
    }
    await vi.runAllTimersAsync();

    // The persisted state must contain BOTH entries (in the pre-fix code, only B survived).
    expect(store.get(STORAGE_KEY)).toEqual({ "1": "A", "2": "B" });
    sm.dispose();
  });

  it("is fire-and-forget: a rejected update() does not throw out of renameSession", () => {
    const memento = createFakeMemento();
    memento._setUpdate(() => Promise.reject(new Error("disk full")));
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview);
    expect(() => sm.renameSession(id, "build")).not.toThrow();
    // In-memory state still updates regardless of persistence failure
    expect(sm.getSession(id)!.customName).toBe("build");
    sm.dispose();
  });
});

describe("SessionManager.createSession: hydration", () => {
  it("hydrates customName from workspaceState for a recycled root-tab number", () => {
    const memento = createFakeMemento({ [STORAGE_KEY]: { "1": "deploy" } });
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    const id = sm.createSession("sidebar", webview); // number = 1
    expect(sm.getSession(id)!.customName).toBe("deploy");
    sm.dispose();
  });

  it("does NOT hydrate for a split-pane session, even if its number has a persisted entry", () => {
    const memento = createFakeMemento({ [STORAGE_KEY]: { "1": "deploy" } });
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    // Force the split pane to receive number = 1 by ensuring no root tab exists first.
    // findAvailableNumber returns 1 since usedNumbers is empty.
    const paneId = sm.createSession("sidebar", webview, { isSplitPane: true });
    expect(sm.getSession(paneId)!.customName).toBeNull();
    sm.dispose();
  });

  it("number recycling reclaims the prior custom name (root tab)", async () => {
    const memento = createFakeMemento();
    const sm = new SessionManager(memento);
    const webview = createMockWebview();
    const id1 = sm.createSession("sidebar", webview); // number = 1
    sm.renameSession(id1, "build");
    sm.destroySession(id1);
    // Drain the async destroy operation queue (performDestroy awaits setTimeout(0)).
    await vi.runAllTimersAsync();
    const id2 = sm.createSession("sidebar", webview); // number = 1 (recycled)
    expect(sm.getSession(id2)!.number).toBe(1);
    expect(sm.getSession(id2)!.customName).toBe("build");
    sm.dispose();
  });
});

describe("SessionManager.getTabsForView: customName field", () => {
  it("includes customName per tab", () => {
    const sm = new SessionManager();
    const webview = createMockWebview();
    const id1 = sm.createSession("sidebar", webview);
    const id2 = sm.createSession("sidebar", webview);
    sm.renameSession(id1, "build");
    const tabs = sm.getTabsForView("sidebar");
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.id === id1)!.customName).toBe("build");
    expect(tabs.find((t) => t.id === id2)!.customName).toBeNull();
    sm.dispose();
  });
});
