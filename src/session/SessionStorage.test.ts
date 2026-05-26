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
    renameSync: vi.fn((from: string, to: string) => {
      const v = files.get(from);
      if (v === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      files.set(to, v);
      files.delete(from);
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
      rename: vi.fn(async (from: string, to: string) => {
        const v = files.get(from);
        if (v === undefined) {
          throw new Error(`ENOENT: ${from}`);
        }
        files.set(to, v);
        files.delete(from);
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

  // ───────────────────────────────────────────────────────────────────
  // [R-3] Transactional commit invariants (design.md D16).
  // Goal: a stale async commit (whose captured-gen was invalidated by a
  // sync write or drop while it awaited) MUST NOT touch the canonical
  // path — only its own temp file.
  // ───────────────────────────────────────────────────────────────────

  describe("transactional commit API (R-3, D16)", () => {
    it("commitBufferSync writes via temp + atomic rename — no temp file survives", async () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();
      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
      s.commitBufferSync("alpha", "DATA");
      expect(files.get(bufferFile("alpha"))).toBe("DATA");
      // No `.tmp.` artifact left over.
      const allFiles = [...files.keys()].filter((k) => k.startsWith(SNAPS_DIR));
      expect(allFiles.filter((k) => k.includes(".tmp."))).toEqual([]);
    });

    it("commitBufferAsync writes via temp + atomic rename", async () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();
      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
      const gen = s.currentBufferGen("alpha");
      await s.commitBufferAsync("alpha", "DATA", gen);
      expect(files.get(bufferFile("alpha"))).toBe("DATA");
      const allFiles = [...files.keys()].filter((k) => k.startsWith(SNAPS_DIR));
      expect(allFiles.filter((k) => k.includes(".tmp."))).toEqual([]);
    });

    it("stale commitBufferAsync after a sync write does NOT overwrite the canonical (R5.B1 fix verified at storage layer)", async () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();

      // Hold the async write so we control completion order.
      let releaseAsync: () => void = () => {};
      const heldPromise = new Promise<void>((resolve) => {
        releaseAsync = resolve;
      });
      const realWriteFile = fs.promises.writeFile;
      fs.promises.writeFile = vi.fn(async (f: string, d: string) => {
        await heldPromise;
        return realWriteFile(f, d);
      });

      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);

      // Capture pre-gen, kick async write (held in promises.writeFile).
      const capturedGen = s.currentBufferGen("alpha");
      const asyncCommit = s.commitBufferAsync("alpha", "ASYNC_STALE", capturedGen);

      // Sync writer lands FIRST — bumps gen and writes canonical synchronously.
      s.commitBufferSync("alpha", "SYNC_FRESH");
      expect(files.get(bufferFile("alpha"))).toBe("SYNC_FRESH");

      // Release the async write. It re-checks the gen, finds mismatch, unlinks
      // ONLY its temp. The canonical must still show SYNC_FRESH.
      releaseAsync();
      await asyncCommit;
      expect(files.get(bufferFile("alpha"))).toBe("SYNC_FRESH");

      // No temp file left over.
      const allFiles = [...files.keys()].filter((k) => k.startsWith(SNAPS_DIR));
      expect(allFiles.filter((k) => k.includes(".tmp."))).toEqual([]);
    });

    it("stale commitBufferAsync after a dropBuffer does NOT recreate the canonical", async () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();

      let releaseAsync: () => void = () => {};
      const heldPromise = new Promise<void>((resolve) => {
        releaseAsync = resolve;
      });
      const realWriteFile = fs.promises.writeFile;
      fs.promises.writeFile = vi.fn(async (f: string, d: string) => {
        await heldPromise;
        return realWriteFile(f, d);
      });

      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
      // Seed an existing canonical.
      s.commitBufferSync("alpha", "INITIAL");
      const capturedGen = s.currentBufferGen("alpha");

      const asyncCommit = s.commitBufferAsync("alpha", "ASYNC_STALE", capturedGen);

      // Drop bumps the gen and unlinks the canonical SYNCHRONOUSLY.
      s.dropBuffer("alpha");
      expect(files.get(bufferFile("alpha"))).toBeUndefined();

      // Release the async write. It must NOT recreate the canonical.
      releaseAsync();
      await asyncCommit;
      expect(files.get(bufferFile("alpha"))).toBeUndefined();

      const allFiles = [...files.keys()].filter((k) => k.startsWith(SNAPS_DIR));
      expect(allFiles.filter((k) => k.includes(".tmp."))).toEqual([]);
    });

    it("commitIndexSync writes the sidecar atomically via temp + rename", () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();
      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
      const idx: SessionSnapshotsIndex = { version: 1, entries: { s1: makeMeta("s1") } };
      s.commitIndexSync(idx);
      expect(JSON.parse(files.get(`${SNAPS_DIR}/index.json`) ?? "")).toEqual(idx);
      const allFiles = [...files.keys()].filter((k) => k.startsWith(SNAPS_DIR));
      expect(allFiles.filter((k) => k.includes(".tmp."))).toEqual([]);
    });

    it("stale commitIndexAsync after commitIndexSync does NOT overwrite the sidecar (R5.B2 fix verified)", async () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();

      let releaseAsync: () => void = () => {};
      const heldPromise = new Promise<void>((resolve) => {
        releaseAsync = resolve;
      });
      const realWriteFile = fs.promises.writeFile;
      fs.promises.writeFile = vi.fn(async (f: string, d: string) => {
        await heldPromise;
        return realWriteFile(f, d);
      });

      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
      const stale: SessionSnapshotsIndex = {
        version: 1,
        entries: { s1: makeMeta("s1", { snapshotAt: 1 }) },
      };
      const fresh: SessionSnapshotsIndex = {
        version: 1,
        entries: { s1: makeMeta("s1", { snapshotAt: 999 }) },
      };

      const capturedGen = s.currentSidecarGen();
      const asyncCommit = s.commitIndexAsync(stale, capturedGen);
      s.commitIndexSync(fresh);
      expect(JSON.parse(files.get(`${SNAPS_DIR}/index.json`) ?? "")).toEqual(fresh);

      releaseAsync();
      await asyncCommit;
      // The sidecar must still reflect the SYNC write — stale async lost.
      expect(JSON.parse(files.get(`${SNAPS_DIR}/index.json`) ?? "")).toEqual(fresh);

      const allFiles = [...files.keys()].filter((k) => k.startsWith(SNAPS_DIR));
      expect(allFiles.filter((k) => k.includes(".tmp."))).toEqual([]);
    });

    it("cleanupOrphanTemps removes leftover *.tmp.* files from a prior crashed write", () => {
      const mem = makeFakeMemento();
      const { fs, files } = makeFakeFs();
      const s = new SessionStorage(mem as unknown as vscode.Memento, STORAGE_URI, fs);
      // Seed a canonical + a stray temp.
      s.commitBufferSync("alpha", "DATA");
      // Simulate orphan: write directly to a temp path.
      files.set(`${SNAPS_DIR}/alpha.snapshot.ans.tmp.999`, "STALE");
      expect(files.get(`${SNAPS_DIR}/alpha.snapshot.ans.tmp.999`)).toBe("STALE");

      s.cleanupOrphanTemps();

      expect(files.get(`${SNAPS_DIR}/alpha.snapshot.ans.tmp.999`)).toBeUndefined();
      expect(files.get(bufferFile("alpha"))).toBe("DATA");
    });
  });
});
