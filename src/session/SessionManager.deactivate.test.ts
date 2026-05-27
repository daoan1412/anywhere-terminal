// Two-step deactivate flush + idempotent dispose tests.
// See: asimov/changes/restore-terminal-sessions/design.md D6.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import type { MessageSender } from "./OutputBuffer";

const mockPtySessions: Array<{
  id: string;
  onData: ((data: string) => void) | undefined;
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
    setShellIntegrationSink = vi.fn();
    setShellIntegrationNonce = vi.fn();
    private _od: ((d: string) => void) | undefined;
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
  const bufferGens = new Map<string, number>();
  let sidecarGen = 0;
  return {
    commitBufferSync: vi.fn((id: string, _data: string) => {
      bufferGens.set(id, (bufferGens.get(id) ?? 0) + 1);
    }),
    commitBufferAsync: vi.fn(async (id: string, _data: string, capturedGen: number) => {
      if ((bufferGens.get(id) ?? 0) !== capturedGen) {
        return "stale-skipped" as const;
      }
      return "renamed" as const;
    }),
    commitIndexSync: vi.fn(() => {
      sidecarGen += 1;
    }),
    commitIndexAsync: vi.fn(async (_idx: unknown, capturedGen: number) => {
      if (sidecarGen !== capturedGen) {
        return "stale-skipped" as const;
      }
      return "renamed" as const;
    }),
    dropBuffer: vi.fn((id: string) => {
      bufferGens.set(id, (bufferGens.get(id) ?? 0) + 1);
    }),
    currentBufferGen: vi.fn((id: string) => bufferGens.get(id) ?? 0),
    currentSidecarGen: vi.fn(() => sidecarGen),
    cleanupOrphanTemps: vi.fn(),
    writeIndexAwaited: vi.fn(async () => {}),
    writeLivePanelsAwaited: vi.fn(async () => {}),
    readBufferFile: () => null,
    listBufferFiles: () => [],
    loadIndex: () => undefined,
    loadLivePanels: () => undefined,
    bufferFilePath: (id: string) => `/tmp/${id}`,
    bufferFileRelativePath: (id: string) => `snapshots/${id}.snapshot.ans`,
    cancelPendingIndex: vi.fn(),
    purge: vi.fn(async () => {}),
  };
}

function makeFactories() {
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
  const serialize: SerializeAddonFactory = () => ({
    serialize: () => "BUFFER",
    dispose() {},
  });
  return { headless, serialize };
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

describe("SessionManager flushSnapshotsSync + flushIndexAwaited", () => {
  it("flushSnapshotsSync writes each active session's buffer synchronously", () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const a = sm.createSession("sidebar", mockWebview());
    const b = sm.createSession("anywhereTerminal.panel", mockWebview());
    mockPtySessions[0].onData?.("aa");
    mockPtySessions[1].onData?.("bb");
    sm.flushSnapshotsSync();
    expect(storage.commitBufferSync).toHaveBeenCalledTimes(2);
    expect(storage.commitBufferSync).toHaveBeenCalledWith(a, "BUFFER");
    expect(storage.commitBufferSync).toHaveBeenCalledWith(b, "BUFFER");
    sm.dispose();
  });

  it("flushIndexAwaited writes live-panels (Memento) + syncs sidecar (D17)", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("x");
    sm.flushSnapshotsSync();
    await sm.flushIndexAwaited();
    // Live-panels still go to Memento (small + churnier — no dual-source bug
    // class). Snapshot index goes to the sidecar via commitIndexSync.
    expect(storage.writeLivePanelsAwaited).toHaveBeenCalledTimes(1);
    expect(storage.commitIndexSync).toHaveBeenCalled();
    sm.dispose();
  });

  it("flushSnapshotsSync is a no-op after dispose (idempotency)", () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    sm.dispose();
    sm.flushSnapshotsSync();
    expect(storage.commitBufferSync).not.toHaveBeenCalled();
  });

  it("dispose is idempotent — second call is a no-op", () => {
    const fx = makeFactories();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
    });
    sm.createSession("sidebar", mockWebview());
    sm.dispose();
    expect(() => sm.dispose()).not.toThrow();
  });

  it("dispose does NOT itself flush — flush is owned by the caller", () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("x");
    sm.dispose();
    expect(storage.commitBufferSync).not.toHaveBeenCalled();
    expect(storage.commitIndexSync).not.toHaveBeenCalled();
    expect(storage.writeLivePanelsAwaited).not.toHaveBeenCalled();
  });
});
