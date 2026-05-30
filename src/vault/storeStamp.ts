// src/vault/storeStamp.ts — Cheap (mtimeMs,size) freshness stamps for SQLite-backed
// stores, shared by the Codex + OpenCode incremental readers (cache-vault-load D3).
//
// Stamping the `.db` (+ `-wal`) lets a refresh skip the expensive snapshot clone +
// query when the store is byte-for-byte unchanged. We deliberately do NOT stamp
// `-shm`: it is volatile wal-index/lock state, not durable content, and would cause
// false invalidations (oracle review). A WAL write changes the `-wal` mtime even
// when it reuses the file at the same size, so `.db`+`-wal` is sufficient.

import * as fs from "node:fs/promises";
import type { FileStamp } from "./cacheTypes";

/** Stat each path into a `(mtimeMs,size)` stamp; silently omit any that don't exist
 *  (e.g. a checkpointed store with no `-wal`). */
export async function stampStoreFiles(paths: string[]): Promise<Record<string, FileStamp>> {
  const out: Record<string, FileStamp> = {};
  for (const p of paths) {
    try {
      const s = await fs.stat(p);
      out[p] = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      // Missing file → omit from the stamp set.
    }
  }
  return out;
}

/** True iff two stamp sets cover the same paths with identical `(mtimeMs,size)`. */
export function sameStamps(a: Record<string, FileStamp>, b: Record<string, FileStamp>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  for (const k of aKeys) {
    const av = a[k];
    const bv = b[k];
    if (!bv || av.mtimeMs !== bv.mtimeMs || av.size !== bv.size) {
      return false;
    }
  }
  return true;
}
