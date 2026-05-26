import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import {
  LIVE_EDITOR_PANELS_KEY,
  type LiveEditorPanelsRecord,
  SESSION_SNAPSHOTS_INDEX_KEY,
  type SessionSnapshotMetadata,
  type SessionSnapshotsIndex,
} from "./SessionSnapshot";
import { type FsLike, SessionStorage } from "./SessionStorage";

function makeFakeMemento(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key: string) => store.get(key),
    update: vi.fn((key: string, value: unknown) => {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    }),
    _snapshot: () => Object.fromEntries(store),
  };
}

function makeFakeFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const writeFileSync = vi.fn((f: string, d: string) => {
    files.set(f, d);
  });
  const writeFile = vi.fn(async (f: string, d: string) => {
    files.set(f, d);
  });
  const fs: FsLike = {
    writeFileSync,
    readFileSync: (f) => {
      const v = files.get(f);
      if (v === undefined) {
        throw new Error(`ENOENT: ${f}`);
      }
      return v;
    },
    mkdirSync: vi.fn((d, _opts) => {
      dirs.add(d);
    }),
    existsSync: (f: string) => files.has(f) || dirs.has(f),
    unlinkSync: vi.fn((f: string) => {
      files.delete(f);
    }),
    readdirSync: (d: string) => {
      const prefix = d.endsWith("/") ? d : `${d}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .filter((name) => !name.includes("/"));
    },
    rmSync: vi.fn((d: string, _opts) => {
      dirs.delete(d);
      for (const k of [...files.keys()]) {
        if (k.startsWith(d.endsWith("/") ? d : `${d}/`)) {
          files.delete(k);
        }
      }
    }),
    promises: {
      writeFile,
      readFile: async (f) => {
        const v = files.get(f);
        if (v === undefined) {
          throw new Error(`ENOENT: ${f}`);
        }
        return v;
      },
      mkdir: vi.fn(async (d, _opts) => {
        dirs.add(d);
        return undefined;
      }),
      unlink: vi.fn(async (f) => {
        files.delete(f);
      }),
    },
  };
  return { fs, files, dirs, writeFileSync, writeFile };
}

const STORAGE_URI = { fsPath: "/tmp/atstorage" } as unknown as vscode.Uri;
const SNAPS_DIR = "/tmp/atstorage/snapshots";

function bufferFile(sessionId: string) {
  return `${SNAPS_DIR}/${sessionId}.snapshot.ans`;
}

function makeMeta(sessionId: string, overrides: Partial<SessionSnapshotMetadata> = {}): SessionSnapshotMetadata {
  return {
    sessionId,
    viewLocation: "sidebar",
    terminalNumber: 1,
    customName: null,
    shell: "/bin/zsh",
    shellArgs: [],
    cwd: "/home/user",
    currentCwd: null,
    cols: 80,
    rows: 24,
    bufferFile: `snapshots/${sessionId}.snapshot.ans`,
    bufferBytes: 0,
    isSplitPane: false,
    rootTabId: sessionId,
    snapshotAt: 1700000000000,
    shellExited: false,
    exitCode: null,
    ...overrides,
  };
}

describe("SessionStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips index + live-panels via workspaceState", async () => {
    const mem = makeFakeMemento();
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);

    const index: SessionSnapshotsIndex = { version: 1, entries: { s1: makeMeta("s1") } };
    const live: LiveEditorPanelsRecord = {
      version: 1,
      panels: [{ panelId: "p1", sessionIds: ["s1"], createdAt: 1, updatedAt: 2 }],
    };
    await s.writeIndexAwaited(index);
    await s.writeLivePanelsAwaited(live);

    const reread = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
    expect(reread.loadIndex()).toEqual(index);
    expect(reread.loadLivePanels()).toEqual(live);
  });

  it("scheduleIndexWrite coalesces N calls into 1 workspaceState.update", () => {
    const mem = makeFakeMemento();
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);

    for (let i = 0; i < 50; i++) {
      s.scheduleIndexWrite({ version: 1, entries: { s1: makeMeta("s1", { snapshotAt: i }) } });
    }
    expect(mem.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(mem.update).toHaveBeenCalledTimes(1);
    expect(mem.update).toHaveBeenCalledWith(SESSION_SNAPSHOTS_INDEX_KEY, {
      version: 1,
      entries: { s1: makeMeta("s1", { snapshotAt: 49 }) },
    });
  });

  it("writeBufferFileSync and writeBufferFileAsync produce identical files", async () => {
    const mem = makeFakeMemento();
    const { fs, files } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);

    s.writeBufferFileSync("sync1", "DATA");
    await s.writeBufferFileAsync("async1", "DATA");

    expect(files.get(bufferFile("sync1"))).toBe("DATA");
    expect(files.get(bufferFile("async1"))).toBe("DATA");
    expect(s.readBufferFile("sync1")).toBe("DATA");
  });

  it("listBufferFiles returns sessionIds of present buffer files", () => {
    const mem = makeFakeMemento();
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
    s.writeBufferFileSync("alpha", "A");
    s.writeBufferFileSync("beta", "B");
    expect(s.listBufferFiles().sort()).toEqual(["alpha", "beta"]);
  });

  it("unlinkBufferFile removes only the named file", () => {
    const mem = makeFakeMemento();
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
    s.writeBufferFileSync("alpha", "A");
    s.writeBufferFileSync("beta", "B");
    s.unlinkBufferFile("alpha");
    expect(s.listBufferFiles()).toEqual(["beta"]);
    expect(s.readBufferFile("alpha")).toBeNull();
  });

  it("purge() clears workspaceState keys and snapshots directory", async () => {
    const mem = makeFakeMemento({
      [SESSION_SNAPSHOTS_INDEX_KEY]: { version: 1, entries: { s1: makeMeta("s1") } },
      [LIVE_EDITOR_PANELS_KEY]: {
        version: 1,
        panels: [{ panelId: "p", sessionIds: ["s1"], createdAt: 1, updatedAt: 1 }],
      },
    });
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
    s.writeBufferFileSync("s1", "DATA");

    await s.purge();
    expect(mem.get(SESSION_SNAPSHOTS_INDEX_KEY)).toBeUndefined();
    expect(mem.get(LIVE_EDITOR_PANELS_KEY)).toBeUndefined();
    expect(s.listBufferFiles()).toEqual([]);
  });

  it("scheduled index write is cancelled by writeIndexAwaited", async () => {
    const mem = makeFakeMemento();
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);

    s.scheduleIndexWrite({ version: 1, entries: { s1: makeMeta("s1") } });
    await s.writeIndexAwaited({ version: 1, entries: {} });
    vi.advanceTimersByTime(2000);

    expect(mem.update).toHaveBeenCalledTimes(1);
    expect(mem.update).toHaveBeenLastCalledWith(SESSION_SNAPSHOTS_INDEX_KEY, { version: 1, entries: {} });
  });

  // ───────────────────────────────────────────────────────────────────
  // [B4] purge() must remove disk artifacts even when workspaceState.update
  // throws (e.g. VS Code raises Canceled mid-shutdown). Same bug shape as
  // the original critical fix's Memento-canceled path. See round-4.md [B4].
  // ───────────────────────────────────────────────────────────────────

  it("purge() removes the snapshots directory even when workspaceState.update throws Canceled (round-4 [B4])", async () => {
    const mem = makeFakeMemento({
      [SESSION_SNAPSHOTS_INDEX_KEY]: { version: 1, entries: { s1: makeMeta("s1") } },
      [LIVE_EDITOR_PANELS_KEY]: {
        version: 1,
        panels: [{ panelId: "p", sessionIds: ["s1"], createdAt: 1, updatedAt: 1 }],
      },
    });
    // Simulate VS Code's mid-shutdown Canceled Thenable on the first Memento
    // update — the exact platform behaviour that produced the original
    // critical-bug fix's need for a sync sidecar. Pre-fix purge() awaits this
    // first, throws unhandled, and never reaches the rmSync that wipes the
    // sidecar + buffer files from disk.
    mem.update.mockImplementationOnce(() => Promise.reject(new Error("Canceled")));

    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
    s.writeBufferFileSync("s1", "DATA");
    // Also seed a sidecar — flushSnapshotsSync writes one at deactivate.
    s.writeIndexSync({ version: 1, entries: { s1: makeMeta("s1") } });

    // Caller treats purge as fire-and-forget; swallow the error so the test
    // simulates production (`void this.storage.purge()`).
    try {
      await s.purge();
    } catch {
      // Expected — first Memento update rejects with Canceled.
    }

    // Disk artifacts MUST be gone even though Memento update threw.
    // Pre-fix: rmSync runs AFTER the awaited Memento updates, so a Canceled
    // first update never reaches the file cleanup.
    expect(s.listBufferFiles()).toEqual([]);
    expect(fs.existsSync(`${SNAPS_DIR}/index.json`)).toBe(false);
  });

  it("purge() still clears Memento when the file rm succeeds first", async () => {
    // Regression guard for the fix: rmSync-first must not skip Memento updates.
    const mem = makeFakeMemento({
      [SESSION_SNAPSHOTS_INDEX_KEY]: { version: 1, entries: { s1: makeMeta("s1") } },
      [LIVE_EDITOR_PANELS_KEY]: {
        version: 1,
        panels: [{ panelId: "p", sessionIds: ["s1"], createdAt: 1, updatedAt: 1 }],
      },
    });
    const { fs } = makeFakeFs();
    const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
    s.writeBufferFileSync("s1", "DATA");

    await s.purge();

    expect(mem.get(SESSION_SNAPSHOTS_INDEX_KEY)).toBeUndefined();
    expect(mem.get(LIVE_EDITOR_PANELS_KEY)).toBeUndefined();
    expect(s.listBufferFiles()).toEqual([]);
  });
});
