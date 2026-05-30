// src/vault/VaultCacheStore.test.ts — Round-trip, corruption, and atomic-write
// behavior of the vault list cache (cache-vault-load task 1_1).

import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type { FsLike } from "../session/SessionStorage";
import { VAULT_CACHE_VERSION, type VaultListCacheFileV1 } from "./cacheTypes";
import { VaultCacheStore } from "./VaultCacheStore";

/** In-memory FsLike: records the temp/rename sequence and the modes used. */
function makeFakeFs() {
  const files = new Map<string, string>();
  const writeOrder: string[] = [];
  const renameOrder: Array<[string, string]> = [];
  const writeModes: Array<number | undefined> = [];
  let mkdirMode: number | undefined;

  const fs = {
    existsSync: (file: string) => files.has(file),
    readFileSync: (file: string) => {
      const v = files.get(file);
      if (v === undefined) {
        throw new Error(`ENOENT: ${file}`);
      }
      return v;
    },
    // Unused by VaultCacheStore but required by the FsLike shape.
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
    unlinkSync: (file: string) => void files.delete(file),
    readdirSync: () => [],
    renameSync: () => undefined,
    promises: {
      mkdir: async (_dir: string, opts?: { mode?: number }) => {
        mkdirMode = opts?.mode;
        return undefined;
      },
      writeFile: async (file: string, data: string, opts?: { mode?: number }) => {
        files.set(file, data);
        writeOrder.push(file);
        writeModes.push(opts?.mode);
      },
      readFile: async (file: string) => files.get(file) ?? "",
      unlink: async (file: string) => void files.delete(file),
      rename: async (from: string, to: string) => {
        const v = files.get(from);
        if (v === undefined) {
          throw new Error(`ENOENT rename: ${from}`);
        }
        files.set(to, v);
        files.delete(from);
        renameOrder.push([from, to]);
      },
    },
  } satisfies FsLike;

  return {
    fs,
    files,
    writeOrder,
    renameOrder,
    writeModes,
    get mkdirMode() {
      return mkdirMode;
    },
  };
}

const globalStorageUri = { fsPath: "/glob" } as vscode.Uri;
const CACHE_FILE = "/glob/vault-cache/list.json";

function doc(overrides: Partial<VaultListCacheFileV1> = {}): VaultListCacheFileV1 {
  return {
    version: VAULT_CACHE_VERSION,
    savedAt: 123,
    agents: {},
    entries: [
      {
        id: "claude:s1",
        agent: "claude",
        sessionId: "s1",
        title: "hello",
        cwd: "/work",
        modified: 10,
        flags: {},
        canFork: false,
      },
    ],
    unreadable: { count: 0, reasons: [] },
    ...overrides,
  };
}

describe("VaultCacheStore", () => {
  let harness: ReturnType<typeof makeFakeFs>;
  let store: VaultCacheStore;

  beforeEach(() => {
    harness = makeFakeFs();
    store = new VaultCacheStore(globalStorageUri, harness.fs);
  });

  it("returns null when no cache file exists", () => {
    expect(store.load()).toBeNull();
  });

  it("round-trips a valid v1 document", async () => {
    const d = doc();
    await store.save(d);
    expect(store.load()).toEqual(d);
  });

  it("writes to a temp path then renames onto the canonical file (atomic)", async () => {
    await store.save(doc());
    expect(harness.writeOrder).toHaveLength(1);
    expect(harness.writeOrder[0]).toMatch(/list\.json\.tmp\.\d+\.\d+$/);
    expect(harness.renameOrder).toEqual([[harness.writeOrder[0], CACHE_FILE]]);
  });

  it("uses owner-only modes (0o600 file, 0o700 dir)", async () => {
    await store.save(doc());
    expect(harness.writeModes[0]).toBe(0o600);
    expect(harness.mkdirMode).toBe(0o700);
  });

  it("treats unparseable JSON as a cache miss", () => {
    harness.files.set(CACHE_FILE, "{ not json");
    expect(store.load()).toBeNull();
  });

  it("discards an unrecognized version (→ full rebuild)", () => {
    harness.files.set(CACHE_FILE, JSON.stringify({ ...doc(), version: 2 }));
    expect(store.load()).toBeNull();
  });

  it("rejects a structurally-invalid document (missing entries array)", () => {
    harness.files.set(CACHE_FILE, JSON.stringify({ version: VAULT_CACHE_VERSION, agents: {}, unreadable: {} }));
    expect(store.load()).toBeNull();
  });

  it("rejects a document with a malformed entry (non-string title)", () => {
    const bad = doc();
    (bad.entries[0] as unknown as { title: unknown }).title = 42;
    harness.files.set(CACHE_FILE, JSON.stringify(bad));
    expect(store.load()).toBeNull();
  });

  it("rejects a document whose unreadable.reasons is not an array", () => {
    harness.files.set(CACHE_FILE, JSON.stringify({ ...doc(), unreadable: { count: 0, reasons: "nope" } }));
    expect(store.load()).toBeNull();
  });

  it("gives each save a fresh temp id", async () => {
    await store.save(doc());
    await store.save(doc());
    expect(harness.writeOrder[0]).not.toBe(harness.writeOrder[1]);
  });
});
