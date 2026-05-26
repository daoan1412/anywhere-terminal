// Headless mirror lifecycle tests.
// See: asimov/changes/restore-terminal-sessions/specs/cross-restart-session-restore/spec.md
// See: asimov/changes/restore-terminal-sessions/design.md D1.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import type { MessageSender } from "./OutputBuffer";

const mockPtySessions: Array<{
  id: string;
  onData: ((data: string) => void) | undefined;
}> = [];

vi.mock("../pty/processCwd", () => ({
  queryProcessCwd: vi.fn(async () => undefined),
}));

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
    setCurrentCwdSink = vi.fn();
    private _onDataCallback: ((data: string) => void) | undefined;
    get onData() {
      return this._onDataCallback;
    }
    set onData(cb: ((data: string) => void) | undefined) {
      this._onDataCallback = cb;
      const tracked = mockPtySessions.find((p) => p.id === this.id);
      if (tracked) {
        tracked.onData = cb;
      }
    }
    onExit: any = undefined;
    constructor(id: string) {
      this.id = id;
      mockPtySessions.push({ id, onData: undefined });
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
      public _id: string,
      public _w: unknown,
      public _p: unknown,
    ) {}
  }
  return { OutputBuffer: MockOutputBuffer };
});

import { type HeadlessFactory, type HeadlessTerminalLike, SessionManager } from "./SessionManager";

function mockWebview(): MessageSender {
  return { postMessage: vi.fn(() => Promise.resolve(true)) };
}

function makeFactory(): { factory: HeadlessFactory; built: HeadlessTerminalLike[]; ctorCalls: number } {
  const built: HeadlessTerminalLike[] = [];
  let ctorCalls = 0;
  const factory: HeadlessFactory = (cols, rows) => {
    ctorCalls++;
    const inst: HeadlessTerminalLike & {
      writes: string[];
      resizes: Array<[number, number]>;
      disposed: boolean;
    } = {
      cols,
      rows,
      writes: [],
      resizes: [],
      disposed: false,
      write(data, cb) {
        this.writes.push(data);
        cb?.();
      },
      resize(c, r) {
        this.resizes.push([c, r]);
      },
      dispose() {
        this.disposed = true;
      },
      loadAddon: vi.fn(),
    };
    built.push(inst);
    return inst;
  };
  return {
    factory,
    built,
    get ctorCalls() {
      return ctorCalls;
    },
  } as { factory: HeadlessFactory; built: HeadlessTerminalLike[]; ctorCalls: number };
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
  mockPtySessions.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionManager headless mirror", () => {
  it("does NOT construct a mirror when restoreEnabled === false", () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: false, headlessFactory: fx.factory });
    sm.createSession("sidebar", mockWebview());
    const pty = mockPtySessions[0];
    pty.onData?.("hello");

    expect((fx as any).ctorCalls).toBe(0);
    expect(fx.built).toHaveLength(0);
    sm.dispose();
  });

  it("lazily constructs the mirror on first PTY data when restoreEnabled === true", () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: true, headlessFactory: fx.factory });
    sm.createSession("sidebar", mockWebview());
    const pty = mockPtySessions[0];

    expect((fx as any).ctorCalls).toBe(0);
    pty.onData?.("hello");
    expect((fx as any).ctorCalls).toBe(1);
    expect((fx.built[0] as any).writes).toEqual(["hello"]);

    pty.onData?.("world");
    expect((fx as any).ctorCalls).toBe(1);
    expect((fx.built[0] as any).writes).toEqual(["hello", "world"]);
    sm.dispose();
  });

  it("forwards resizeSession() to the headless mirror after the mirror exists", () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: true, headlessFactory: fx.factory });
    const id = sm.createSession("sidebar", mockWebview());
    const pty = mockPtySessions[0];
    pty.onData?.("first");
    sm.resizeSession(id, 120, 40);

    expect((fx.built[0] as any).resizes).toEqual([[120, 40]]);
    sm.dispose();
  });

  it("disposes the headless mirror when the session is destroyed", async () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: true, headlessFactory: fx.factory });
    const id = sm.createSession("sidebar", mockWebview());
    const pty = mockPtySessions[0];
    pty.onData?.("x");
    sm.destroySession(id);

    // Flush the operation queue (destroySession schedules via Promise queue).
    await new Promise((r) => setTimeout(r, 5));

    expect((fx.built[0] as any).disposed).toBe(true);
  });

  it("uses the session's current cols/rows when constructing the mirror", () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: true, headlessFactory: fx.factory });
    const id = sm.createSession("sidebar", mockWebview());
    sm.resizeSession(id, 132, 50); // before any data — mirror not yet built
    const pty = mockPtySessions[0];
    pty.onData?.("data");

    expect(fx.built[0].cols).toBe(132);
    expect(fx.built[0].rows).toBe(50);
    sm.dispose();
  });

  it("seeds the headless mirror with restoreFrom.buffer on restore so subsequent serialize includes prior history", () => {
    // Regression: a second Cmd+R after the first restore was losing all prior
    // content because the new headless mirror started empty — only the new
    // shell prompt was serialized. Restoring MUST seed the mirror with the
    // previously-serialized buffer so the next snapshot captures restored +
    // new output together.
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: true, headlessFactory: fx.factory });
    const restoredSessionId = "RESTORED-1";
    sm.createSession("sidebar", mockWebview(), {
      shell: "/bin/zsh",
      restoreFrom: {
        metadata: {
          sessionId: restoredSessionId,
          viewLocation: "sidebar",
          terminalNumber: 1,
          customName: null,
          shell: "/bin/zsh",
          shellArgs: [],
          cwd: "/tmp",
          currentCwd: null,
          cols: 80,
          rows: 24,
          bufferFile: `snapshots/${restoredSessionId}.snapshot.ans`,
          bufferBytes: 32,
          isSplitPane: false,
          rootTabId: restoredSessionId,
          snapshotAt: 1700000000000,
          shellExited: false,
          exitCode: null,
        },
        buffer: "PRIOR-CONTENT-FROM-DISK",
      },
    });

    // The mirror must be built eagerly + seeded with the prior buffer BEFORE
    // any pty.onData fires.
    expect((fx as any).ctorCalls).toBe(1);
    expect((fx.built[0] as any).writes).toEqual(["PRIOR-CONTENT-FROM-DISK"]);

    // New PTY output then appends — the seeded content stays in front.
    const pty = mockPtySessions[0];
    pty.onData?.("NEW-PROMPT");
    expect((fx.built[0] as any).writes).toEqual(["PRIOR-CONTENT-FROM-DISK", "NEW-PROMPT"]);

    sm.dispose();
  });

  it("does NOT seed the mirror when restoring an exited shell (read-only, no further persists)", () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: true, headlessFactory: fx.factory });
    const exitedId = "EXITED-1";
    sm.createSession("sidebar", mockWebview(), {
      shell: "/bin/zsh",
      restoreFrom: {
        metadata: {
          sessionId: exitedId,
          viewLocation: "sidebar",
          terminalNumber: 2,
          customName: null,
          shell: "/bin/zsh",
          shellArgs: [],
          cwd: "/tmp",
          currentCwd: null,
          cols: 80,
          rows: 24,
          bufferFile: `snapshots/${exitedId}.snapshot.ans`,
          bufferBytes: 10,
          isSplitPane: false,
          rootTabId: exitedId,
          snapshotAt: 1700000000000,
          shellExited: true,
          exitCode: 0,
        },
        buffer: "EXITED-BUFFER",
      },
    });
    expect((fx as any).ctorCalls).toBe(0);
    sm.dispose();
  });

  it("does NOT seed when restoreEnabled === false (kill switch honored)", () => {
    const fx = makeFactory();
    const sm = new SessionManager(undefined, { restoreEnabled: false, headlessFactory: fx.factory });
    sm.createSession("sidebar", mockWebview(), {
      shell: "/bin/zsh",
      restoreFrom: {
        metadata: {
          sessionId: "X",
          viewLocation: "sidebar",
          terminalNumber: 3,
          customName: null,
          shell: "/bin/zsh",
          shellArgs: [],
          cwd: "/tmp",
          currentCwd: null,
          cols: 80,
          rows: 24,
          bufferFile: "snapshots/X.snapshot.ans",
          bufferBytes: 5,
          isSplitPane: false,
          rootTabId: "X",
          snapshotAt: 1700000000000,
          shellExited: false,
          exitCode: null,
        },
        buffer: "SHOULD-NOT-BE-SEEDED",
      },
    });
    expect((fx as any).ctorCalls).toBe(0);
    sm.dispose();
  });
});
