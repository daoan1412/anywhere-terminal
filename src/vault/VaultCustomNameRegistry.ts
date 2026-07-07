// src/vault/VaultCustomNameRegistry.ts — Global persistence of user-supplied custom
// names for vault sessions, keyed by entryId ("<agent>:<sessionId>").
// See enhance-vault-sessions design.md D1.
//
// Mirrors src/session/CustomNameRegistry (in-memory map is authoritative, fire-and-forget
// snapshot to the Memento) but is keyed by the vault entryId and applied as a serve-time
// overlay in VaultService — it NEVER writes an agent's own session store.

/** Hard cap for a custom name; longer input is silently truncated. Mirrors CustomNameRegistry. */
export const CUSTOM_NAME_MAX_LENGTH = 80;

/**
 * Normalize a user-supplied vault name: trim, then cap at CUSTOM_NAME_MAX_LENGTH.
 * Returns null when empty after trimming (the caller clears the name). Shared by
 * this registry AND the rename handler's native-write path so a natively-written
 * title gets the exact same trim + cap as an overlay name (write-vault-rename-to-store D3).
 */
export function normalizeVaultCustomName(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > CUSTOM_NAME_MAX_LENGTH ? trimmed.slice(0, CUSTOM_NAME_MAX_LENGTH) : trimmed;
}

/** globalState key for the vault custom-name record. */
const VAULT_CUSTOM_NAMES_STORAGE_KEY = "anywhereTerminal.vaultCustomNames";

/**
 * Minimal subset of `vscode.Memento` (read/write key-value) actually used.
 * Declared locally so tests can pass a tiny in-memory fake without importing vscode.
 */
export interface VaultCustomNameStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/** No-op storage — used when no Memento is available; overlay simply no-ops. */
export const noopVaultCustomNameStorage: VaultCustomNameStorage = {
  get: () => undefined,
  update: () => Promise.resolve(),
};

export class VaultCustomNameRegistry {
  private readonly cache: Map<string, string>;

  constructor(private readonly storage: VaultCustomNameStorage) {
    this.cache = this.loadFromStorage();
  }

  /** The custom name for an entryId, or undefined when none. */
  get(entryId: string): string | undefined {
    return this.cache.get(entryId);
  }

  /**
   * Set or clear the custom name for an entryId. The raw input is normalized
   * (trimmed + capped); an empty-after-trim value clears the entry. Fires a
   * fire-and-forget snapshot to storage.
   */
  set(entryId: string, name: string): void {
    const normalized = this.normalize(name);
    if (normalized === null) {
      this.cache.delete(entryId);
    } else {
      this.cache.set(entryId, normalized);
    }
    this.saveSnapshot();
  }

  /** Snapshot of all custom names, keyed by entryId. */
  all(): Readonly<Record<string, string>> {
    const snapshot: Record<string, string> = {};
    for (const [k, v] of this.cache) {
      snapshot[k] = v;
    }
    return snapshot;
  }

  private normalize(input: string): string | null {
    return normalizeVaultCustomName(input);
  }

  private loadFromStorage(): Map<string, string> {
    const raw = this.storage.get(VAULT_CUSTOM_NAMES_STORAGE_KEY);
    const result = new Map<string, string>();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return result;
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") {
        result.set(k, v);
      }
    }
    return result;
  }

  private saveSnapshot(): void {
    void this.storage.update(VAULT_CUSTOM_NAMES_STORAGE_KEY, this.all()).then(undefined, (err) => {
      console.error("[AnyWhere Terminal] Failed to persist vault custom names:", err);
    });
  }
}
