// src/vault/VaultService.customName.test.ts — custom-name overlay is cache-safe
// (enhance-vault-sessions 2_4 / D1).

import { describe, expect, it } from "vitest";
import type { VaultListCacheFileV1 } from "./cacheTypes";
import { VAULT_CACHE_VERSION } from "./cacheTypes";
import type { VaultCacheStore } from "./VaultCacheStore";
import { VaultCustomNameRegistry } from "./VaultCustomNameRegistry";
import { VaultService } from "./VaultService";
import type { VaultSessionEntry } from "./types";

function entry(id: string, title: string): VaultSessionEntry {
  const [agent, sessionId] = id.split(":");
  return { id, agent, sessionId, title, cwd: "/x", modified: 1, flags: {}, canFork: false };
}

function docWith(entries: VaultSessionEntry[]): VaultListCacheFileV1 {
  return { version: VAULT_CACHE_VERSION, savedAt: 1, agents: {}, entries, unreadable: { count: 0, reasons: [] } };
}

function memStorage() {
  const store = new Map<string, unknown>();
  return { get: (k: string) => store.get(k), update: (k: string, v: unknown) => (store.set(k, v), Promise.resolve()) };
}

describe("VaultService custom-name overlay", () => {
  it("overlays customName on listCached() without mutating the cache doc", () => {
    const doc = docWith([entry("claude:a", "original title"), entry("codex:b", "other")]);
    const cacheStore = { load: () => doc, save: async () => {} } as unknown as VaultCacheStore;
    const registry = new VaultCustomNameRegistry(memStorage());
    const svc = new VaultService({ cacheStore, customNames: registry });

    svc.setCustomName("claude:a", "Renamed");
    const listed = svc.listCached();
    expect(listed).not.toBeNull();
    const a = listed?.entries.find((e) => e.id === "claude:a");
    const b = listed?.entries.find((e) => e.id === "codex:b");
    // Renamed entry carries customName; derived title is untouched.
    expect(a?.customName).toBe("Renamed");
    expect(a?.title).toBe("original title");
    // Un-renamed entry has no customName.
    expect(b?.customName).toBeUndefined();

    // The cache doc (persisted source of truth) is never polluted.
    expect(doc.entries.find((e) => e.id === "claude:a")?.customName).toBeUndefined();
  });

  it("clears the overlay when the custom name is cleared", () => {
    const doc = docWith([entry("claude:a", "original title")]);
    const cacheStore = { load: () => doc, save: async () => {} } as unknown as VaultCacheStore;
    const registry = new VaultCustomNameRegistry(memStorage());
    const svc = new VaultService({ cacheStore, customNames: registry });

    svc.setCustomName("claude:a", "Renamed");
    expect(svc.listCached()?.entries[0].customName).toBe("Renamed");
    svc.setCustomName("claude:a", "   ");
    expect(svc.listCached()?.entries[0].customName).toBeUndefined();
    expect(svc.listCached()?.entries[0].title).toBe("original title");
  });

  it("is a no-op without a registry", () => {
    const doc = docWith([entry("claude:a", "original title")]);
    const cacheStore = { load: () => doc, save: async () => {} } as unknown as VaultCacheStore;
    const svc = new VaultService({ cacheStore });
    expect(svc.listCached()?.entries[0].customName).toBeUndefined();
  });
});
