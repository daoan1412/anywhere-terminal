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
