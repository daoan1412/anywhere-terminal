// Debounced persistence tests.
// See: asimov/changes/restore-terminal-sessions/design.md D6.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import type { MessageSender } from "./OutputBuffer";

const mockPtySessions: Array<{
  id: string;
  onData: ((data: string) => void) | undefined;
  onExit: ((code: number) => void) | undefined;
}> = [];

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
    setCurrentCwdSink = vi.fn();
    private _od: ((d: string) => void) | undefined;
    private _oe: ((c: number) => void) | undefined;
    get onData() {
      return this._od;
    }
    set onData(cb: ((d: string) => void) | undefined) {
      this._od = cb;
      const t = mockPtySessions.find((p) => p.id === this.id);
      if (t) {
        t.onData = cb;
      }
    }
    get onExit() {
      return this._oe;
    }
    set onExit(cb: ((c: number) => void) | undefined) {
      this._oe = cb;
      const t = mockPtySessions.find((p) => p.id === this.id);
      if (t) {
        t.onExit = cb;
      }
    }
    constructor(id: string) {
      this.id = id;
      mockPtySessions.push({ id, onData: undefined, onExit: undefined });
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

import { type HeadlessFactory, type SerializeAddonFactory, SessionManager } from "./SessionManager";

function mockWebview(): MessageSender {
  return { postMessage: vi.fn(() => Promise.resolve(true)) };
}

function makeStorageMock() {
  const writeBufferFileAsync = vi.fn(async (_id: string, _data: string) => {});
  const scheduleIndexWrite = vi.fn();
  const unlinkBufferFile = vi.fn();
  const writeBufferFileSync = vi.fn();
  const writeIndexAwaited = vi.fn(async () => {});
  const writeLivePanelsAwaited = vi.fn(async () => {});
  return {
    writeBufferFileAsync,
    writeBufferFileSync,
    scheduleIndexWrite,
    unlinkBufferFile,
    writeIndexAwaited,
    writeLivePanelsAwaited,
    readBufferFile: () => null,
    listBufferFiles: () => [],
    loadIndex: () => undefined,
    loadLivePanels: () => undefined,
    bufferFilePath: (id: string) => `/tmp/snap/${id}`,
    bufferFileRelativePath: (id: string) => `snapshots/${id}.snapshot.ans`,
    cancelPendingIndex: vi.fn(),
    purge: vi.fn(async () => {}),
  };
}

function makeFactories() {
  let serializeCount = 0;
  const headless: HeadlessFactory = (cols, rows) => ({
    cols,
    rows,
    write(_data, cb) {
      cb?.();
    },
    resize() {},
    dispose() {},
    loadAddon() {},
  });
  const serialize: SerializeAddonFactory = () => {
    const out = `BUF#${++serializeCount}`;
    return {
      serialize: () => out,
      dispose() {},
    };
  };
  return { headless, serialize };
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockPtySessions.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionManager debounced persistence", () => {
  it("coalesces 50 pty.onData events into 1 buffer write + 1 scheduleIndexWrite", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    sm.createSession("sidebar", mockWebview());

    for (let i = 0; i < 50; i++) {
      mockPtySessions[0].onData?.(`chunk-${i}`);
    }
    expect(storage.writeBufferFileAsync).not.toHaveBeenCalled();
    expect(storage.scheduleIndexWrite).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(storage.writeBufferFileAsync).toHaveBeenCalledTimes(1);
    expect(storage.scheduleIndexWrite).toHaveBeenCalledTimes(1);
    sm.dispose();
  });

  it("a meta change (rename) also schedules a persist", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("seed");
    await vi.advanceTimersByTimeAsync(1000);
    storage.writeBufferFileAsync.mockClear();
    storage.scheduleIndexWrite.mockClear();

    sm.renameSession(id, "build");
    await vi.advanceTimersByTimeAsync(1000);

    expect(storage.writeBufferFileAsync).toHaveBeenCalledTimes(1);
    expect(storage.scheduleIndexWrite).toHaveBeenCalledTimes(1);
    sm.dispose();
  });

  it("a setCurrentCwd update schedules a persist", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("seed");
    await vi.advanceTimersByTimeAsync(1000);
    storage.writeBufferFileAsync.mockClear();
    storage.scheduleIndexWrite.mockClear();

    sm.setCurrentCwd(id, "/home/user/proj");
    await vi.advanceTimersByTimeAsync(1000);

    expect(storage.writeBufferFileAsync).toHaveBeenCalledTimes(1);
    expect(storage.scheduleIndexWrite).toHaveBeenCalledTimes(1);
    sm.dispose();
  });

  it("destroy mid-flush does NOT resurrect the snapshot index entry (round-2 [W3])", async () => {
    // Setup: a flush is mid-await on writeBufferFileAsync when destroySession
    // fires. The pre-W3 code path would then synchronously re-insert the index
    // entry after detachSession had just dropped it — resurrecting a ghost.
    const fx = makeFactories();
    let resolveWrite: () => void = () => {};
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const storage = makeStorageMock();
    // Slow writeBufferFileAsync — held until we explicitly resolve it.
    storage.writeBufferFileAsync.mockImplementation(async () => {
      await writePromise;
    });

    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("hello");
    // Kick the debounce so flushPending starts.
    vi.advanceTimersByTime(1000);
    // Hand control back so flushPending awaits writeBufferFileAsync.
    await Promise.resolve();
    await Promise.resolve();

    // Destroy the session WHILE the async write is still in flight.
    // detachSession will unlink the file and drop the index entry.
    sm.destroySession(id);

    // Now release the write. Pre-W3: line 466 (`_snapshotIndex[id] = result.metadata`)
    // would resurrect the entry. Post-W3: the per-session liveness re-check
    // (`if (!this.getSession(id)) { unlinkBufferFile(id); continue; }`) skips
    // the assignment AND unlinks the just-written ghost file.
    resolveWrite();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    // The index write that flushPending schedules at the end should NOT
    // contain the destroyed session.
    const calls = storage.scheduleIndexWrite.mock.calls;
    const lastCall = calls[calls.length - 1];
    if (lastCall) {
      const idx = lastCall[0] as { entries: Record<string, unknown> };
      expect(idx.entries[id]).toBeUndefined();
    }
    // The file MUST be unlinked twice: once by detachSession, once by the
    // post-await ghost-cleanup. Vitest's mock counts both calls.
    expect(storage.unlinkBufferFile).toHaveBeenCalledWith(id);
    sm.dispose();
  });

  it("clearScrollback purges the persisted snapshot for a no-mirror restored-exited session (round-2 [B1])", async () => {
    // Setup: createSession with restoreFrom.metadata.shellExited === true.
    // attachSession skips headless-mirror seeding for exited sessions, so the
    // resulting TerminalSession has no `headless` field. resetMirror's
    // early-return on no-mirror previously left the persisted buffer + index
    // entry intact — Cmd+K on a restored-exited tab then resurrected the
    // cleared content on next restart. Post-B1: resetMirror routes through
    // purgePersistedSnapshot, which unlinks the buffer + drops the index entry.
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });

    const sessionId = "exited-session";
    const id = sm.createSession("sidebar", mockWebview(), {
      restoreFrom: {
        metadata: {
          sessionId,
          viewLocation: "sidebar",
          terminalNumber: 1,
          customName: null,
          shell: "/bin/zsh",
          shellArgs: [],
          cwd: "/tmp",
          currentCwd: null,
          cols: 80,
          rows: 24,
          bufferFile: `snapshots/${sessionId}.snapshot.ans`,
          bufferBytes: 100,
          isSplitPane: false,
          rootTabId: sessionId,
          snapshotAt: Date.now() - 1000,
          shellExited: true,
          exitCode: 0,
        },
        buffer: "stale content",
      },
    });

    // Confirm the precondition: no headless mirror on the exited session.
    expect(sm.getSession(id)?.headless).toBeUndefined();

    storage.unlinkBufferFile.mockClear();
    storage.scheduleIndexWrite.mockClear();

    sm.clearScrollback(id);

    // The persisted buffer file MUST be unlinked.
    expect(storage.unlinkBufferFile).toHaveBeenCalledWith(id);
    // Index rewrite scheduled (without this session's entry).
    expect(storage.scheduleIndexWrite).toHaveBeenCalled();
    const lastIndexCall = storage.scheduleIndexWrite.mock.calls.at(-1)?.[0] as
      | { entries: Record<string, unknown> }
      | undefined;
    expect(lastIndexCall?.entries[id]).toBeUndefined();
    sm.dispose();
  });

  it("the setting kill-switch suppresses persistence", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: false,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    sm.createSession("sidebar", mockWebview());
    for (let i = 0; i < 10; i++) {
      mockPtySessions[0].onData?.("x");
    }
    await vi.advanceTimersByTimeAsync(2000);

    expect(storage.writeBufferFileAsync).not.toHaveBeenCalled();
    expect(storage.scheduleIndexWrite).not.toHaveBeenCalled();
    sm.dispose();
  });
});
