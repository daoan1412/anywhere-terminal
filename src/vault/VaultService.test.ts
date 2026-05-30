// src/vault/VaultService.test.ts — Unit tests for aggregation + fork resolution.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ReaderListCache,
  type ReaderResultWithState,
  VAULT_CACHE_VERSION,
  type VaultListCacheFileV1,
} from "./cacheTypes";
import { __resetForkSupportCache, canForkOpenCode, gte, parseFirstSemver } from "./forkSupport";
import type { VaultSessionEntry } from "./types";
import type { VaultCacheStore } from "./VaultCacheStore";
import { type VaultEntryReaders, type VaultReaders, VaultService } from "./VaultService";

function entry(agent: string, sessionId: string, modified: number): VaultSessionEntry {
  return {
    id: `${agent}:${sessionId}`,
    agent,
    sessionId,
    title: sessionId,
    cwd: "/x",
    modified,
    flags: {},
    canFork: false,
  };
}

function result(entries: VaultSessionEntry[], unreadable = 0): ReaderResultWithState {
  return { entries, unreadable, cache: { kind: "store", sources: {}, entries, unreadable } };
}

function makeReaders(overrides: Partial<VaultReaders> = {}): VaultReaders {
  return {
    claude: vi.fn(async () => result([])),
    codex: vi.fn(async () => result([])),
    opencode: vi.fn(async () => result([])),
    ...overrides,
  };
}

function makeEntryReaders(overrides: Partial<VaultEntryReaders> = {}): VaultEntryReaders {
  return {
    claude: vi.fn(async () => null),
    codex: vi.fn(async () => null),
    opencode: vi.fn(async () => null),
    ...overrides,
  };
}

describe("VaultService.list: aggregation", () => {
  it("merges entries from all readers sorted by modified desc", async () => {
    const readers = makeReaders({
      claude: async () => result([entry("claude", "c1", 100)]),
      codex: async () => result([entry("codex", "x1", 300)]),
      opencode: async () => result([entry("opencode", "o1", 200)]),
    });
    const svc = new VaultService({ readers, canForkOpenCodeFn: async () => true });
    const { entries } = await svc.list();
    expect(entries.map((e) => e.id)).toEqual(["codex:x1", "opencode:o1", "claude:c1"]);
  });

  it("sums unreadable across readers", async () => {
    const readers = makeReaders({
      claude: async () => result([entry("claude", "c1", 1)], 2),
      codex: async () => result([], 1),
    });
    const svc = new VaultService({ readers, canForkOpenCodeFn: async () => false });
    const { unreadable } = await svc.list();
    expect(unreadable.count).toBe(3);
  });

  it("a reader that throws contributes 0 entries + 1 unreadable, others survive", async () => {
    const readers = makeReaders({
      claude: async () => {
        throw new Error("reader blew up");
      },
      codex: async () => result([entry("codex", "x1", 5)]),
    });
    const svc = new VaultService({ readers, canForkOpenCodeFn: async () => false });
    const { entries, unreadable } = await svc.list();
    expect(entries.map((e) => e.id)).toEqual(["codex:x1"]);
    expect(unreadable.count).toBe(1);
  });

  it("a reader that throws synchronously does not abort aggregation", async () => {
    const readers = makeReaders({
      claude: () => {
        throw new Error("sync reader blew up");
      },
      codex: async () => result([entry("codex", "x1", 5)]),
    });
    const svc = new VaultService({ readers, canForkOpenCodeFn: async () => false });
    const { entries, unreadable } = await svc.list();
    expect(entries.map((e) => e.id)).toEqual(["codex:x1"]);
    expect(unreadable.count).toBe(1);
  });
});

describe("VaultService.list: fork resolution", () => {
  it("claude + codex are forkable (forkCommand present, no version gate)", async () => {
    const readers = makeReaders({
      claude: async () => result([entry("claude", "c1", 2)]),
      codex: async () => result([entry("codex", "x1", 1)]),
    });
    const svc = new VaultService({ readers, canForkOpenCodeFn: async () => false });
    const { entries } = await svc.list();
    expect(entries.every((e) => e.canFork)).toBe(true);
  });

  it("opencode canFork follows the version probe (true)", async () => {
    const readers = makeReaders({ opencode: async () => result([entry("opencode", "o1", 1)]) });
    const svc = new VaultService({ readers, canForkOpenCodeFn: async () => true });
    const { entries } = await svc.list();
    expect(entries[0].canFork).toBe(true);
  });

  it("opencode canFork is false when the probe says so", async () => {
    const probe = vi.fn(async () => false);
    const readers = makeReaders({ opencode: async () => result([entry("opencode", "o1", 1)]) });
    const svc = new VaultService({ readers, canForkOpenCodeFn: probe });
    const { entries } = await svc.list();
    expect(entries[0].canFork).toBe(false);
    expect(probe).toHaveBeenCalledWith("1.1.54");
  });

  it("opencode canFork is false when the probe rejects", async () => {
    const probe = vi.fn(async () => {
      throw new Error("probe failed");
    });
    const readers = makeReaders({ opencode: async () => result([entry("opencode", "o1", 1)]) });
    const svc = new VaultService({ readers, canForkOpenCodeFn: probe });
    const { entries } = await svc.list();
    expect(entries[0].canFork).toBe(false);
  });

  it("does NOT spawn the opencode probe when there are no opencode entries", async () => {
    const probe = vi.fn(async () => true);
    const readers = makeReaders({ claude: async () => result([entry("claude", "c1", 1)]) });
    const svc = new VaultService({ readers, canForkOpenCodeFn: probe });
    await svc.list();
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("VaultService.getEntry: single-entry resolve", () => {
  it("resolves ONLY the matching agent's reader (others not called) — the fast launch path", async () => {
    const claude = vi.fn(async () => entry("claude", "c1", 1));
    const codex = vi.fn(async () => null);
    const opencode = vi.fn(async () => null);
    const svc = new VaultService({ entryReaders: { claude, codex, opencode }, canForkOpenCodeFn: async () => false });
    const e = await svc.getEntry("claude:c1");
    expect(e?.id).toBe("claude:c1");
    expect(claude).toHaveBeenCalledWith("c1");
    expect(codex).not.toHaveBeenCalled();
    expect(opencode).not.toHaveBeenCalled();
  });

  it("returns null for an unknown agent or a malformed id", async () => {
    const svc = new VaultService({ entryReaders: makeEntryReaders(), canForkOpenCodeFn: async () => false });
    expect(await svc.getEntry("bogus:x")).toBeNull();
    expect(await svc.getEntry("no-colon")).toBeNull();
  });

  it("returns null when the agent reader can't resolve the session", async () => {
    const svc = new VaultService({
      entryReaders: makeEntryReaders({ codex: vi.fn(async () => null) }),
      canForkOpenCodeFn: async () => false,
    });
    expect(await svc.getEntry("codex:missing")).toBeNull();
  });

  it("resolves canFork for claude WITHOUT spawning the opencode probe", async () => {
    const probe = vi.fn(async () => true);
    const svc = new VaultService({
      entryReaders: makeEntryReaders({ claude: vi.fn(async () => entry("claude", "c1", 1)) }),
      canForkOpenCodeFn: probe,
    });
    const e = await svc.getEntry("claude:c1");
    expect(e?.canFork).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("opencode canFork follows the probe (and only opencode triggers it)", async () => {
    const probe = vi.fn(async () => true);
    const svc = new VaultService({
      entryReaders: makeEntryReaders({ opencode: vi.fn(async () => entry("opencode", "o1", 1)) }),
      canForkOpenCodeFn: probe,
    });
    const e = await svc.getEntry("opencode:o1");
    expect(e?.canFork).toBe(true);
    expect(probe).toHaveBeenCalledWith("1.1.54");
  });

  it("opencode canFork is false when the probe says so", async () => {
    const svc = new VaultService({
      entryReaders: makeEntryReaders({ opencode: vi.fn(async () => entry("opencode", "o1", 1)) }),
      canForkOpenCodeFn: async () => false,
    });
    const e = await svc.getEntry("opencode:o1");
    expect(e?.canFork).toBe(false);
  });
});

describe("VaultService cache: listCached + refresh", () => {
  function makeCacheStore(initial: VaultListCacheFileV1 | null = null) {
    let stored = initial;
    const store = {
      load: vi.fn(() => stored),
      save: vi.fn(async (doc: VaultListCacheFileV1) => {
        stored = doc;
      }),
    };
    return {
      store,
      get current() {
        return stored;
      },
    };
  }

  function cacheDoc(entries: VaultSessionEntry[]): VaultListCacheFileV1 {
    return {
      version: VAULT_CACHE_VERSION,
      savedAt: 1,
      agents: {},
      entries,
      unreadable: { count: 0, reasons: [] },
    };
  }

  it("listCached returns null without a cache store", () => {
    const svc = new VaultService({ readers: makeReaders(), canForkOpenCodeFn: async () => false });
    expect(svc.listCached()).toBeNull();
  });

  it("listCached serves the persisted list (loaded once)", () => {
    const { store } = makeCacheStore(cacheDoc([entry("claude", "c1", 7)]));
    const svc = new VaultService({
      readers: makeReaders(),
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    expect(svc.listCached()?.entries.map((e) => e.id)).toEqual(["claude:c1"]);
    svc.listCached();
    expect(store.load).toHaveBeenCalledTimes(1); // lazy-loaded once, then memoized
  });

  it("refresh persists the merged+sorted doc and returns it", async () => {
    const { store, current } = makeCacheStore(null);
    const readers = makeReaders({
      claude: async () => result([entry("claude", "c1", 100)]),
      codex: async () => result([entry("codex", "x1", 300)]),
    });
    const svc = new VaultService({
      readers,
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    const { entries } = await svc.refresh();
    expect(entries.map((e) => e.id)).toEqual(["codex:x1", "claude:c1"]);
    expect(store.save).toHaveBeenCalledTimes(1);
    // After refresh, listCached serves the freshly persisted list.
    expect(svc.listCached()?.entries.map((e) => e.id)).toEqual(["codex:x1", "claude:c1"]);
    void current;
  });

  it("a second refresh feeds each reader its prior per-agent cache (incremental)", async () => {
    const claude = vi.fn(async (_prev?: ReaderListCache) => result([entry("claude", "c1", 1)]));
    const { store } = makeCacheStore(null);
    const svc = new VaultService({
      readers: makeReaders({ claude }),
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    await svc.refresh();
    await svc.refresh();
    // First call: no prior cache (undefined). Second: the cache the reader returned
    // last time, carried back as `prev` (canFork already resolved on the entry).
    expect(claude.mock.calls[0][0]).toBeUndefined();
    const prev = claude.mock.calls[1][0];
    expect(prev?.kind).toBe("store");
    expect(prev?.kind === "store" && prev.entries.map((e) => e.id)).toEqual(["claude:c1"]);
  });

  it("single-flight: concurrent refresh calls share one read + one save", async () => {
    const claude = vi.fn(async () => result([entry("claude", "c1", 1)]));
    const { store } = makeCacheStore(null);
    const svc = new VaultService({
      readers: makeReaders({ claude }),
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it("F1: a transient reader failure preserves that agent's last-cached entries + cache", async () => {
    let claudeOk = true;
    const claude = vi.fn(async (_prev?: ReaderListCache) => {
      if (!claudeOk) {
        throw new Error("transient fs error");
      }
      return result([entry("claude", "c1", 100)]);
    });
    const { store } = makeCacheStore(null);
    const svc = new VaultService({
      readers: makeReaders({ claude, codex: async () => result([entry("codex", "x1", 50)]) }),
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    await svc.refresh(); // first read succeeds → claude:c1 cached
    claudeOk = false;
    const res = await svc.refresh(); // claude reader now fails transiently
    // claude:c1 survives from the prior snapshot instead of vanishing; codex still reads fresh.
    expect(res.entries.map((e) => e.id).sort()).toEqual(["claude:c1", "codex:x1"]);
    expect(res.unreadable.reasons.some((r) => r.includes("showing last cached"))).toBe(true);
    // The persisted snapshot keeps the agent so the next open still shows it.
    expect(
      svc
        .listCached()
        ?.entries.map((e) => e.id)
        .sort(),
    ).toEqual(["claude:c1", "codex:x1"]);
  });

  it("F1: a reader failing on the FIRST read (nothing to carry) just surfaces unreadable", async () => {
    const { store } = makeCacheStore(null);
    const svc = new VaultService({
      readers: makeReaders({
        claude: async () => {
          throw new Error("boom");
        },
        codex: async () => result([entry("codex", "x1", 50)]),
      }),
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    const res = await svc.refresh();
    expect(res.entries.map((e) => e.id)).toEqual(["codex:x1"]);
    expect(res.unreadable.reasons.some((r) => r.includes("reader failed"))).toBe(true);
    expect(res.unreadable.reasons.some((r) => r.includes("showing last cached"))).toBe(false);
  });

  it("a save failure does not fail the refresh (fresh list still returned)", async () => {
    const store = {
      load: vi.fn(() => null),
      save: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const svc = new VaultService({
      readers: makeReaders({ claude: async () => result([entry("claude", "c1", 1)]) }),
      canForkOpenCodeFn: async () => false,
      cacheStore: store as unknown as VaultCacheStore,
    });
    const { entries } = await svc.refresh();
    expect(entries.map((e) => e.id)).toEqual(["claude:c1"]);
  });
});

describe("forkSupport helpers", () => {
  beforeEach(() => __resetForkSupportCache());

  it("parseFirstSemver extracts the first X.Y.Z", () => {
    expect(parseFirstSemver("opencode 1.14.50 (build)")).toEqual([1, 14, 50]);
    expect(parseFirstSemver("no version here")).toBeUndefined();
  });

  it("gte compares semvers", () => {
    expect(gte([1, 14, 50], [1, 14, 50])).toBe(true);
    expect(gte([1, 14, 51], [1, 14, 50])).toBe(true);
    expect(gte([1, 14, 49], [1, 14, 50])).toBe(false);
    expect(gte([2, 0, 0], [1, 99, 99])).toBe(true);
  });

  it("canForkOpenCode is true when the probe reports a high-enough version", async () => {
    const deps = { exec: vi.fn(async () => ({ stdout: "1.20.0", stderr: "" })) };
    expect(await canForkOpenCode("1.14.50", deps)).toBe(true);
  });

  it("canForkOpenCode is false for an older version", async () => {
    const deps = { exec: vi.fn(async () => ({ stdout: "1.10.0", stderr: "" })) };
    expect(await canForkOpenCode("1.14.50", deps)).toBe(false);
  });

  it("canForkOpenCode is false when the probe throws (binary missing)", async () => {
    const deps = {
      exec: vi.fn(async () => {
        throw new Error("not found");
      }),
    };
    expect(await canForkOpenCode("1.14.50", deps)).toBe(false);
  });
});
