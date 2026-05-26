// Cross-method temporal coupling tests for shutdown / lifecycle interleavings.
//
// These probe scenarios that per-method code review cannot see — interleavings
// of dispose, destroySession, clearScrollback, pty.onExit, and flushPending.
//
// Round-4 review (.reviews/round-4.md) identified four BLOCK findings of this
// shape. Each test below was written to REPRODUCE one of them; they should
// fail against pre-round-4 code and pass after the round-4 fixes land.
//   - B1: queued destroy preserved by dispose via releaseMirror
//   - B2: flushPending re-entry overwrites cleared snapshot
//   - B3: non-killed pty.onExit destroys exited-shell snapshot (D13 violation)
// (B4 covers SessionStorage.purge() ordering — see SessionStorage.test.ts.)

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
  const writeBufferFileSync = vi.fn();
  const scheduleIndexWrite = vi.fn();
  const unlinkBufferFile = vi.fn();
  const writeIndexAwaited = vi.fn(async () => {});
  const writeLivePanelsAwaited = vi.fn(async () => {});
  const writeIndexSync = vi.fn();
  return {
    writeBufferFileAsync,
    writeBufferFileSync,
    scheduleIndexWrite,
    unlinkBufferFile,
    writeIndexAwaited,
    writeLivePanelsAwaited,
    writeIndexSync,
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
  // Per-session serialize counter so each generateSnapshotMetadata returns
  // a unique buffer payload — lets us tell pre-clear from post-clear writes.
  let serializeCount = 0;
  let nextSerialize: string | null = null;
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
    serialize: () => {
      if (nextSerialize !== null) {
        const v = nextSerialize;
        nextSerialize = null;
        return v;
      }
      return `BUF#${++serializeCount}`;
    },
    dispose() {},
  });
  return {
    headless,
    serialize,
    setNextSerialize: (v: string) => {
      nextSerialize = v;
    },
  };
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
  mockPtySessions.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// [B1] Queued user destroy + deactivate race
//      A destroySession enqueued (or mid-flight) at deactivate time
//      MUST end in destructive cleanup (snapshot dropped), not be silently
//      preserved by dispose's releaseMirror path. Otherwise the closed tab
//      reappears on next activate.
// ─────────────────────────────────────────────────────────────────────

describe("SessionManager dispose vs queued destroy (round-4 [B1])", () => {
  it("a queued destroySession that has NOT yet started must NOT survive dispose as a preserved snapshot", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("important user content");

    // Queue a destroy via the operation queue. The microtask has NOT run yet
    // (Promise.resolve().then is queued, performDestroy hasn't started) —
    // mirroring the case where deactivate fires before destroy drains.
    sm.destroySession(id);

    // User-deactivate sequence: sync flush → dispose. The bug: dispose walks
    // sessions.keys() (still includes the doomed id because performDestroy
    // hasn't reached cleanupSession yet) and calls releaseMirror — preserving
    // a session the user explicitly destroyed.
    sm.flushSnapshotsSync();
    sm.dispose();

    // Let the queued performDestroy microtask drain (it will early-return
    // from cleanupSession because sessions is already empty post-dispose).
    await Promise.resolve();
    await Promise.resolve();

    // The snapshot for the doomed session MUST have been torn down —
    // either by detachSession during dispose (post-fix), or via an explicit
    // unlink. Pre-fix: releaseMirror preserved the entry + buffer file.
    const remaining = sm.getSnapshotIndexEntries();
    expect(remaining[id]).toBeUndefined();
    expect(storage.unlinkBufferFile).toHaveBeenCalledWith(id);
  });

  it("a destroyAllForView queued before dispose must also drop snapshots, not preserve them", async () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const a = sm.createSession("anywhereTerminal.sidebar", mockWebview());
    const b = sm.createSession("anywhereTerminal.sidebar", mockWebview());
    mockPtySessions[0].onData?.("a-data");
    mockPtySessions[1].onData?.("b-data");

    // Queue a view-wide destroy — covers the editor grace-period destroy path
    // that fires when an editor panel closes without revival.
    sm.destroyAllForView("anywhereTerminal.sidebar");

    sm.flushSnapshotsSync();
    sm.dispose();

    await Promise.resolve();
    await Promise.resolve();

    const remaining = sm.getSnapshotIndexEntries();
    expect(remaining[a]).toBeUndefined();
    expect(remaining[b]).toBeUndefined();
    expect(storage.unlinkBufferFile).toHaveBeenCalledWith(a);
    expect(storage.unlinkBufferFile).toHaveBeenCalledWith(b);
  });
});

// ─────────────────────────────────────────────────────────────────────
// [B2] flushPending re-entry overwrites cleared snapshot
//      A debounced flush mid-await on writeBufferFileAsync MUST NOT
//      assign stale pre-clear metadata to _snapshotIndex after a
//      subsequent clearScrollback + flushSessionImmediate completes.
// ─────────────────────────────────────────────────────────────────────

describe("SnapshotPersistence flushPending re-entry vs clearScrollback (round-4 [B2])", () => {
  it("a stale pre-clear write completing AFTER the post-clear write must not overwrite the cleared index entry", async () => {
    vi.useFakeTimers();
    const fx = makeFactories();
    const storage = makeStorageMock();

    // Per-id queue of {resolve, data} so we control completion order.
    const pending: Array<{ resolve: () => void; data: string }> = [];
    storage.writeBufferFileAsync.mockImplementation(async (_id: string, data: string) => {
      await new Promise<void>((resolve) => {
        pending.push({ resolve, data });
      });
    });

    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());

    // PRE-clear: send data; force a recognisable buffer label.
    fx.setNextSerialize("PRE_CLEAR_BUFFER");
    mockPtySessions[0].onData?.("pre-data");

    // Kick the debounce → flushPending starts → awaits writeBufferFileAsync.
    // advanceTimersByTimeAsync also drains microtasks until the next async
    // boundary, so flushPending reaches its writeBufferFileAsync await.
    await vi.advanceTimersByTimeAsync(1000);
    expect(pending.length).toBe(1);
    expect(pending[0].data).toBe("PRE_CLEAR_BUFFER");

    // Now clearScrollback fires while the pre-clear async write is still HELD.
    // resetMirror chains the RIS, flushSessionImmediate → flushPending (call B).
    fx.setNextSerialize("");
    sm.clearScrollback(id);
    // Drain microtasks until call B reaches its own writeBufferFileAsync await.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.length).toBe(2);
    expect(pending[1].data).toBe("");

    // Force the BUG ordering: resolve the post-clear write FIRST (call B finishes),
    // then the stale pre-clear write (call A finishes). Pre-fix, call A
    // re-assigns _snapshotIndex[id] = stale pre-clear metadata after B already
    // wrote the cleared entry — and the stale buffer payload on disk is the
    // "last write wins" pre-clear content.
    pending[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    pending[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // The final index entry MUST reflect the cleared snapshot (empty buffer).
    // Pre-fix: this is "PRE_CLEAR_BUFFER" because A's late assignment wins.
    const idx = sm.getSnapshotIndexEntries();
    expect(idx[id]).toBeDefined();
    expect(idx[id].bufferBytes).toBe(0);

    sm.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────
// [B3] Non-killed pty.onExit destroys the exited-shell snapshot
//      Per design.md D13, exited entries are KEPT for read-only restore.
//      But cleanupSession calls detachSession which unlinks the buffer
//      and drops the index entry immediately after onExit fires.
// ─────────────────────────────────────────────────────────────────────

describe("SessionManager pty.onExit preserves exited-shell snapshot (round-4 [B3], D13)", () => {
  it("non-killed pty.onExit must persist the exit snapshot synchronously and PRESERVE its index entry", () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());
    // Populate the headless mirror so generateSnapshotMetadata has content.
    mockPtySessions[0].onData?.("exit-state-data");

    // Non-killed exit (shell exits naturally — user typed `exit`).
    mockPtySessions[0].onExit?.(0);

    // Per design.md D13: exited entries are KEPT (restored read-only).
    // Pre-fix: cleanupSession → detachSession unlinks the file + drops the
    // index entry immediately, BEFORE the async immediate-persist has a
    // chance to write the exit snapshot. Post-fix: an exit-snapshot is
    // written synchronously AND the entry survives in _snapshotIndex.
    const idx = sm.getSnapshotIndexEntries();
    expect(idx[id]).toBeDefined();
    expect(idx[id]?.shellExited).toBe(true);
    expect(idx[id]?.exitCode).toBe(0);

    // The buffer file MUST NOT have been unlinked by the cleanup path.
    expect(storage.unlinkBufferFile).not.toHaveBeenCalledWith(id);
    // The exit snapshot MUST have been written (sync, since the async path
    // would race with cleanupSession). Pre-fix this never happens.
    expect(storage.writeBufferFileSync).toHaveBeenCalledWith(id, expect.any(String));

    sm.dispose();
  });

  it("the persisted exit snapshot survives the full deactivate sequence (flushSnapshotsSync + dispose)", () => {
    const fx = makeFactories();
    const storage = makeStorageMock();
    const sm = new SessionManager(undefined, {
      restoreEnabled: true,
      headlessFactory: fx.headless,
      serializeAddonFactory: fx.serialize,
      storage: storage as any,
    });
    const id = sm.createSession("sidebar", mockWebview());
    mockPtySessions[0].onData?.("final-output");
    mockPtySessions[0].onExit?.(137);

    // After exit but before deactivate: the entry must already be persisted
    // and present in the index (so flushSnapshotsSync's eviction sees it).
    const preDeactivate = sm.getSnapshotIndexEntries();
    expect(preDeactivate[id]).toBeDefined();

    // User reloads / quits — deactivate sequence.
    sm.flushSnapshotsSync();
    sm.dispose();

    // The exit snapshot must NOT have been unlinked at any point in the
    // deactivate path. Pre-fix the unlink fires inside cleanupSession even
    // before deactivate begins.
    expect(storage.unlinkBufferFile).not.toHaveBeenCalledWith(id);
  });
});
