// src/vault/VaultCacheStore.ts — Persist the vault session list to a single
// owner-only JSON sidecar so the panel can display instantly on open
// (cache-vault-load design.md D4).
//
// Mirrors the proven SessionStorage pattern: atomic temp+rename writes, a
// version-guarded load that treats anything unrecognized as a cache miss, and
// `0o600`/`0o700` modes (the at-rest mitigation for the bounded title + cwd we
// persist — see design.md D5). The cache is NON-AUTHORITATIVE: every open still
// follows the cached render with a source-of-truth refresh, so a discarded or
// stale cache only costs one slower open, never correctness.

import * as path from "node:path";
import type * as vscode from "vscode";
import type { FsLike } from "../session/SessionStorage";
import { VAULT_CACHE_VERSION, type VaultListCacheFileV1 } from "./cacheTypes";
import type { VaultSessionEntry } from "./types";

/** Minimal shape check on a persisted entry so a tampered/garbled cache element
 *  can't reach the webview and throw in render/signature (a poisoned `sessionPath`
 *  is harmless — actions always re-resolve paths by id host-side — but a non-string
 *  `title` would crash `.toLowerCase()` in search). Any malformed entry voids the
 *  whole cache → full rebuild. */
function isValidCachedEntry(e: unknown): e is VaultSessionEntry {
  if (!e || typeof e !== "object") {
    return false;
  }
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.agent === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.title === "string" &&
    typeof v.cwd === "string" &&
    typeof v.modified === "number" &&
    typeof v.canFork === "boolean" &&
    typeof v.flags === "object" &&
    v.flags !== null &&
    (v.sessionPath === undefined || typeof v.sessionPath === "string")
  );
}

/** Owner-only file mode — the cache holds bounded titles + absolute cwds that
 *  MAY carry sensitive content (design.md D5). Matches SessionStorage [W5]. */
const CACHE_FILE_MODE = 0o600;
/** Owner-only directory mode for `<globalStorageUri>/vault-cache/`. */
const CACHE_DIR_MODE = 0o700;

export class VaultCacheStore {
  private readonly cacheDir: string;
  private readonly cacheFile: string;
  /** Monotonic temp-id so concurrent writers never collide on the spool path. */
  private tempCounter = 0;

  constructor(
    globalStorageUri: vscode.Uri,
    private readonly fs: FsLike,
  ) {
    this.cacheDir = path.join(globalStorageUri.fsPath, "vault-cache");
    this.cacheFile = path.join(this.cacheDir, "list.json");
  }

  /**
   * Load the cached list synchronously (fast path for the first response). Returns
   * `null` — treated as "no cache", triggering a full rebuild — when the file is
   * missing, unreadable, unparseable, or carries an unrecognized `version`. Never
   * throws and never returns a partial document.
   */
  load(): VaultListCacheFileV1 | null {
    if (!this.fs.existsSync(this.cacheFile)) {
      return null;
    }
    try {
      const raw = this.fs.readFileSync(this.cacheFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<VaultListCacheFileV1>;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === VAULT_CACHE_VERSION &&
        Array.isArray(parsed.entries) &&
        parsed.entries.every(isValidCachedEntry) &&
        parsed.agents &&
        typeof parsed.agents === "object" &&
        parsed.unreadable &&
        typeof parsed.unreadable === "object" &&
        Array.isArray(parsed.unreadable.reasons)
      ) {
        return parsed as VaultListCacheFileV1;
      }
    } catch {
      // Torn/corrupt/unreadable cache — treat as a miss (full rebuild). No
      // partial recovery: the refresh that follows is the source of truth.
    }
    return null;
  }

  /**
   * Persist the cache document. Atomic: `mkdir` → write `list.json.tmp.<n>` →
   * `rename` onto the canonical path (atomic on the same filesystem), so a reader
   * never observes a half-written file. Callers SHOULD `await` this (VaultService
   * does, inside its single-flight refresh) so writes stay ordered.
   */
  async save(doc: VaultListCacheFileV1): Promise<void> {
    await this.fs.promises.mkdir(this.cacheDir, { recursive: true, mode: CACHE_DIR_MODE });
    // Temp name is unique across processes (pid) AND within one process (counter).
    // `globalStorageUri` is shared by every VS Code window, so a per-instance
    // counter alone would collide between windows and lose a write (oracle review).
    const temp = `${this.cacheFile}.tmp.${process.pid}.${++this.tempCounter}`;
    await this.fs.promises.writeFile(temp, JSON.stringify(doc), { mode: CACHE_FILE_MODE });
    await this.fs.promises.rename(temp, this.cacheFile);
  }

  /**
   * Best-effort reaping of `list.json.tmp.*` files orphaned by a crash between
   * write and rename (or by a lost cross-window rename race). Each orphan is an
   * owner-readable file holding titles+cwds, so leaving them to accumulate widens
   * the at-rest footprint. Call once on activate. Mirrors SessionStorage.
   */
  cleanupOrphanTemps(): void {
    try {
      if (!this.fs.existsSync(this.cacheDir)) {
        return;
      }
      for (const name of this.fs.readdirSync(this.cacheDir)) {
        if (name.startsWith("list.json.tmp.")) {
          try {
            this.fs.unlinkSync(path.join(this.cacheDir, name));
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }
}
