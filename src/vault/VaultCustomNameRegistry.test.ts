import { describe, expect, it } from "vitest";
import {
  CUSTOM_NAME_MAX_LENGTH,
  normalizeVaultCustomName,
  VaultCustomNameRegistry,
  type VaultCustomNameStorage,
} from "./VaultCustomNameRegistry";

function fakeStorage(initial?: Record<string, unknown>): {
  storage: VaultCustomNameStorage;
  written: () => unknown;
} {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    storage: {
      get: (k) => store.get(k),
      update: (k, v) => {
        store.set(k, v);
        return Promise.resolve();
      },
    },
    written: () => store.get("anywhereTerminal.vaultCustomNames"),
  };
}

describe("VaultCustomNameRegistry", () => {
  it("sets and gets a custom name by entryId", () => {
    const { storage } = fakeStorage();
    const reg = new VaultCustomNameRegistry(storage);
    reg.set("claude:abc", "My session");
    expect(reg.get("claude:abc")).toBe("My session");
    expect(reg.get("codex:xyz")).toBeUndefined();
  });

  it("trims input and clears on empty-after-trim", () => {
    const { storage } = fakeStorage();
    const reg = new VaultCustomNameRegistry(storage);
    reg.set("claude:abc", "  spaced  ");
    expect(reg.get("claude:abc")).toBe("spaced");
    reg.set("claude:abc", "   ");
    expect(reg.get("claude:abc")).toBeUndefined();
  });

  it("caps an over-length name at 80 chars", () => {
    const { storage } = fakeStorage();
    const reg = new VaultCustomNameRegistry(storage);
    reg.set("claude:abc", "x".repeat(200));
    expect(reg.get("claude:abc")).toHaveLength(80);
  });

  it("persists a snapshot to storage and rehydrates from it", () => {
    const first = fakeStorage();
    const reg = new VaultCustomNameRegistry(first.storage);
    reg.set("opencode:1", "kept");
    expect(first.written()).toEqual({ "opencode:1": "kept" });

    // A fresh registry over the same backing store rehydrates.
    const reg2 = new VaultCustomNameRegistry(first.storage);
    expect(reg2.get("opencode:1")).toBe("kept");
    expect(reg2.all()).toEqual({ "opencode:1": "kept" });
  });

  it("ignores malformed persisted data", () => {
    const { storage } = fakeStorage({ "anywhereTerminal.vaultCustomNames": ["not", "a", "map"] });
    const reg = new VaultCustomNameRegistry(storage);
    expect(reg.all()).toEqual({});
  });
});

describe("normalizeVaultCustomName (shared by overlay + native write)", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeVaultCustomName("  hello  ")).toBe("hello");
  });

  it("returns null for empty-after-trim", () => {
    expect(normalizeVaultCustomName("   ")).toBeNull();
    expect(normalizeVaultCustomName("")).toBeNull();
  });

  it("caps at CUSTOM_NAME_MAX_LENGTH", () => {
    const out = normalizeVaultCustomName("x".repeat(200));
    expect(out).toHaveLength(CUSTOM_NAME_MAX_LENGTH);
  });

  it("leaves a within-cap name unchanged", () => {
    expect(normalizeVaultCustomName("Renamed session")).toBe("Renamed session");
  });
});
