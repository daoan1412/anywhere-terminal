// src/session/CustomNameRegistry.ts — Per-workspace persistence of user-supplied
// custom tab names, keyed by terminal number. See add-tab-rename design.md D3, D7, D9.
//
// Hydrated once at construction; mutations are race-free synchronous map ops with a
// fire-and-forget snapshot to the Memento. The in-memory map is the authoritative
// copy — avoids the load-modify-save race where concurrent renames each load empty
// and each write back only their own entry.

/** Hard cap for a custom name; longer input is silently truncated. */
const CUSTOM_NAME_MAX_LENGTH = 80;

/** workspaceState key for the per-terminal-number custom-name record. */
const CUSTOM_NAMES_STORAGE_KEY = "anywhereTerminal.tabCustomNames";

/**
 * Minimal subset of `vscode.Memento` (read/write key-value) actually used.
 * Declared locally so tests can pass a tiny in-memory fake without importing vscode.
 */
export interface CustomNameStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/** No-op storage used when no Memento is provided — sessions still work, just without persistence. */
export const noopCustomNameStorage: CustomNameStorage = {
  get: () => undefined,
  update: () => Promise.resolve(),
};

export class CustomNameRegistry {
  private readonly cache: Map<string, string>;

  constructor(private readonly storage: CustomNameStorage) {
    this.cache = this.loadFromStorage();
  }

  /** Get the persisted custom name for a terminal number, or null when none. */
  getForNumber(num: number): string | null {
    return this.cache.get(String(num)) ?? null;
  }

  /**
   * Set or clear the persisted custom name for a terminal number. Accepts the
   * caller-normalized value (use `normalize()` first if needed). Fires a
   * fire-and-forget snapshot to storage.
   */
  setForNumber(num: number, normalized: string | null): void {
    const key = String(num);
    if (normalized === null) {
      this.cache.delete(key);
    } else {
      this.cache.set(key, normalized);
    }
    this.saveSnapshot();
  }

  /**
   * Normalize a rename input to the canonical `customName` value:
   *   - null / undefined / empty-after-trim → null (reset to auto-name)
   *   - longer than CUSTOM_NAME_MAX_LENGTH → silently truncated
   *   - otherwise → trimmed string
   */
  normalize(input: string | null): string | null {
    if (input === null) {
      return null;
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > CUSTOM_NAME_MAX_LENGTH) {
      return trimmed.slice(0, CUSTOM_NAME_MAX_LENGTH);
    }
    return trimmed;
  }

  private loadFromStorage(): Map<string, string> {
    const raw = this.storage.get(CUSTOM_NAMES_STORAGE_KEY);
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
    const snapshot: Record<string, string> = {};
    for (const [k, v] of this.cache) {
      snapshot[k] = v;
    }
    void this.storage.update(CUSTOM_NAMES_STORAGE_KEY, snapshot).then(undefined, (err) => {
      console.error("[AnyWhere Terminal] Failed to persist custom tab names:", err);
    });
  }
}
