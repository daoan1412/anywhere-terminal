// src/vault/VaultService.test.ts — Unit tests for aggregation + fork resolution.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForkSupportCache, canForkOpenCode, gte, parseFirstSemver } from "./forkSupport";
import type { ReaderResult } from "./readers/claudeReader";
import type { VaultSessionEntry } from "./types";
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

function result(entries: VaultSessionEntry[], unreadable = 0): ReaderResult {
  return { entries, unreadable };
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
