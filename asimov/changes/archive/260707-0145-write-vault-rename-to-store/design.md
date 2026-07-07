# Design: write-vault-rename-to-store

## Decisions

### D1: Hybrid routing — native write for the 2 SQLite agents, overlay for Claude

Route `handleVaultRenameSession` on the agent parsed from the entry id `<agent>:<sessionId>`:

- `opencode` / `codex` → native SQLite `UPDATE ... title` (with overlay fallback).
- `claude` and any unknown agent → the existing `VaultService.setCustomName` overlay, unchanged.

Rationale: OpenCode (`session.title`) and Codex (`threads.title`) both expose a real, user-editable title column, and real-source review confirms an explicit rename is **preserved** on later activity (Codex `prefer_existing_explicit_title` keeps a title that differs from the first user message; OpenCode's `ensureTitle` only runs while the title is still its default placeholder). Claude's title is derived from a summary/first-prompt record in an append-only JSONL — there is no title field to set, and appending a synthetic summary record to an agent-owned file is fragile. Rejected: writing Claude too (no clean target).

### D2: A separate live-DB write helper — the read path cannot be reused

The reader (`readSqlite`) copies the store (+ `-wal`/`-shm`) into a temp dir and queries the **copy**, on purpose (a read-only open of a live WAL DB can silently return empty; D13 of the read design). A write to a throwaway copy is discarded, so the write needs its own path: a new `writeSqlite(dbPath, sql, params, deps?)` that opens the **live** DB read-write via `node:sqlite` `DatabaseSync`, sets `PRAGMA busy_timeout = 5000`, runs one parameterized `UPDATE` in autocommit (no long transaction), and closes.

- `node:sqlite`-only: the `sqlite3` CLI's parameter binding is clunky and injection-prone; concatenating the user name into CLI argv is unacceptable. When `node:sqlite` is unavailable (probe reuses `sqlite.ts`'s memoized `probeNodeSqlite`), the write is a no-op that reports `no-sqlite3` and the caller falls back to the overlay. This preserves the read-only guarantee on runtimes that can't safely write.
- Status enum mirrors the reader's discriminated result: `ok` | `no-sqlite3` | `no-db` | `not-found` (`changes === 0`) | `write-error`. Only `ok` (with `changes > 0`) counts as a successful native write.
- **No-create / missing-table safety** (oracle F6): `writeSqlite` checks `exists(dbPath)` first (→ `no-db`). `node:sqlite` `DatabaseSync` has no read-write-no-create mode, so a file vanishing between the check and the open would create an empty DB; the subsequent `UPDATE` then hits `no such table` → throw → `write-error` (never `ok`). So a stray open never counts as success and always degrades to the overlay; we do not attempt stray-file cleanup (out of scope for the appetite).

Rejected: a `sqlite3` CLI write fallback (injection surface, no real benefit on the host Node 22 runtime where `node:sqlite` is guaranteed by `engines.vscode ^1.105`).

### D3: Precedence — native success clears the overlay; failure and empty-name fall back to overlay

The name is **normalized once, up front** (oracle F1): `handleVaultRenameSession` calls a shared `normalizeVaultCustomName(input)` (trim + cap `CUSTOM_NAME_MAX_LENGTH = 80`, extracted from `VaultCustomNameRegistry`) → `string | null` (null = empty after trim). Both the native write and the overlay consume the SAME normalized value, so a native title can never exceed the cap or carry surrounding whitespace that the overlay would have trimmed.

- Normalized name is **non-null** + agent∈{opencode,codex} → native write with the normalized string. On success (`ok`, `changes > 0`) → clear any sidecar name for that entry (`setCustomName(entryId, "")`) so the agent-owned `title` is the single source of truth, then fresh-refresh (D4) and post.
- Native write **fails** (`no-sqlite3` / `no-db` / `not-found` / `write-error`) → `setCustomName(entryId, normalized)` and serve via the existing overlay, exactly like Claude — the user still sees their name.
- **Null** (empty after trim) name for opencode/codex → clear the overlay only (`setCustomName(entryId, "")`); never write an empty title into the store (that would wipe the agent's real title). A previously native-written title stays (documented limitation — the store can't recover the original auto-title; storing the prior title for true revert is out of scope, oracle F3).

Rationale: keeping both the overlay and a native title for the same entry would create two competing names; the overlay is retained strictly as a failure fallback. Both writes are scoped to the list's visibility so a stale/forged entry id can't mutate a hidden row: Codex `UPDATE … WHERE id = ? AND archived = 0` (oracle F4); OpenCode `UPDATE … WHERE id = ? AND (parent_id IS NULL OR parent_id = '')`, mirroring the list's root-session filter (review W2). A non-matching id yields `changes = 0` → `not-found` → overlay fallback.

### D4: Fresh refresh strictly AFTER the write (single-flight bypass)

The overlay path serves from `listCached()` (instant) because the cache already carries the overlay. A native write changes the store on disk, so the cache is stale — the native branch must re-read.

`VaultService.refresh()` is **single-flight** (`if (this.inflightRefresh) return this.inflightRefresh`). A refresh already in flight when the write completes — e.g. the store watcher fired on our own `UPDATE`, or a concurrent list refresh — started its `readAll` *before* the write, so joining it would post the **pre-write** title (oracle F2). The native branch therefore uses a fresh read that is guaranteed to start after the write: add `refresh(opts?: { force?: boolean })` — when `force` and a refresh is in-flight, `await this.inflightRefresh` first, then run a new (non-joined) read; otherwise behave exactly as today.

The per-store incremental cache is keyed on `[dbPath, dbPath-wal]` file stamps, which the `UPDATE` bumps, so the fresh read re-queries rather than reusing the stale entry — but correctness rests on the force-refresh ordering, **not** on the stamp alone (oracle F5). No manual WAL checkpoint or `-wal` touch is needed or wanted (SQLite manages the sidecar; a checkpoint would be more invasive). The post is routed through the existing `_vaultRefreshSeq` token so it still wins over any older in-flight post.

## Architecture

```mermaid
sequenceDiagram
    participant W as Webview
    participant P as TerminalViewProvider
    participant V as VaultService
    participant R as Reader (opencode/codex)
    participant S as writeSqlite
    participant DB as Live SQLite store

    W->>P: vaultRenameSession {entryId, name}
    P->>P: normalizeVaultCustomName(name) → norm | null
    P->>P: parse agent from entryId
    alt agent = opencode | codex, norm non-null
        P->>V: writeNativeTitle(entryId, norm)
        V->>R: rename<Agent>(sessionId, norm)
        R->>S: writeSqlite(dbPath, "UPDATE ... title=? WHERE id=? [AND archived=0]", [norm, id])
        S->>DB: DatabaseSync(live, rw); PRAGMA busy_timeout=5000; run()
        DB-->>S: changes
        S-->>V: {status, changes}
        V-->>P: ok? (changes>0)
        alt ok
            P->>V: setCustomName(entryId, "")  %% clear overlay
            P->>V: refresh({ force: true })  %% reads AFTER the write
        else native failed
            P->>V: setCustomName(entryId, norm)  %% overlay fallback
        end
    else agent = claude | unknown, or norm null
        P->>V: setCustomName(entryId, norm|"")  %% overlay path (unchanged)
    end
    P-->>W: vaultSessionsResponse (refreshed / overlaid)
```

## Interfaces

```ts
// src/vault/sqlite.ts
export type SqliteWriteStatus = "ok" | "no-sqlite3" | "no-db" | "not-found" | "write-error";
export interface SqliteWriteResult { status: SqliteWriteStatus; changes: number; error?: string; }
export interface SqliteWriteDeps {
  exists(p: string): Promise<boolean>;
  hasNodeSqlite?(): Promise<boolean>;
  // Executes the parameterized UPDATE against the LIVE db; defaults to a real node:sqlite writer.
  runNodeWrite?(dbPath: string, sql: string, params: (string | number)[]): Promise<SqliteWriteResult>;
}
export function writeSqlite(
  dbPath: string, sql: string, params: (string | number)[], deps?: SqliteWriteDeps,
): Promise<SqliteWriteResult>;

// src/vault/VaultCustomNameRegistry.ts — extracted, shared by the registry AND the handler.
export const CUSTOM_NAME_MAX_LENGTH = 80;
export function normalizeVaultCustomName(input: string): string | null; // trim + cap; null = empty

// src/vault/readers/opencodeReader.ts — SQL: "UPDATE session SET title = ? WHERE id = ? AND (parent_id IS NULL OR parent_id = '')"
export function renameOpenCodeSession(sessionId: string, name: string, options?: OpenCodeReaderOptions): Promise<boolean>;
// src/vault/readers/codexReader.ts — SQL: "UPDATE threads SET title = ? WHERE id = ? AND archived = 0"
export function renameCodexThread(threadId: string, name: string, options?: CodexReaderOptions): Promise<boolean>;

// src/vault/VaultService.ts
// true iff a store row was updated; false → caller uses the overlay.
writeNativeTitle(entryId: string, name: string): Promise<boolean>;
refresh(opts?: { force?: boolean }): Promise<VaultListResult>; // force → read strictly after any in-flight refresh
```

`runNodeWrite` default implementation:
```ts
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(dbPath); // read-write (default)
try {
  db.exec("PRAGMA busy_timeout = 2000"); // short: sync engine — bound the UI block, degrade to overlay (review S3)
  const info = db.prepare(sql).run(...params); // params bound, never concatenated
  return { status: Number(info.changes) > 0 ? "ok" : "not-found", changes: Number(info.changes) };
} finally { db.close(); }
```
`node:sqlite` is synchronous, so `busy_timeout` doubles as a hard cap on how long `run()` can block the extension-host event loop under WAL-lock contention. It is kept **short (2000ms, not the agents' own 5000ms)**: a rename is best-effort, so on timeout the write degrades cleanly to the overlay — far better than freezing the UI. Agent write-locks are sub-100ms, so the ceiling is essentially never reached (review S3).

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `writeSqlite` on live WAL DB | Concurrent agent holds the write lock → `SQLITE_BUSY`, or the sync engine blocks the UI | `PRAGMA busy_timeout = 2000` — short because the engine is synchronous (bounds the main-thread block; review S3); single short autocommit `UPDATE`, DB closed immediately; timeout/error → `write-error` → overlay fallback |
| User-supplied name | SQL injection | Bound parameter only (`run(...params)`); id already guarded by `isSafeOpenCodeId`/`isSafeCodexId` before the call |
| `node:sqlite` absent (old/locked runtime) | Import throws | Reuse memoized `probeNodeSqlite`; absent → `no-sqlite3` → overlay fallback (read-only guarantee preserved) |
| Codex dual source (SQLite + rollout JSONL) | Reconcile clobbers the DB title | Confirmed `prefer_existing_explicit_title` keeps a title ≠ first user message (a real rename always differs) — DB-only `UPDATE` sticks (discovery Finding 2) |
| OpenCode auto-title | `ensureTitle` overwrites the rename | Confirmed `ensureTitle` runs only while the title is the default placeholder — an explicit title is never regenerated (discovery Finding 3) |
| Stale list after write | An in-flight (pre-write) `refresh()` is reused → posts the old title; or two concurrent force reads interleave | `refresh({ force: true })` **drains** all in-flight reads (`while (inflightRefresh) await …`) then starts a fresh one strictly after the write — this also serializes concurrent force refreshes so no two `run`s persist out of order (D4, oracle F2, review W1); stamp bump is a secondary aid, not the guarantee |
| Unnormalized native title | Native write bypasses the overlay's trim + 80-cap → over-long/whitespace title in the store | Shared `normalizeVaultCustomName` (trim + cap 80) applied up front before BOTH native write and overlay (D3, oracle F1) |
| Forged/stale entry id | Renames an archived/hidden/child row | Both writes scoped to list visibility: Codex `AND archived = 0` (oracle F4), OpenCode `AND (parent_id IS NULL OR parent_id = '')` (review W2); id already guarded by `isSafeCodexId`/`isSafeOpenCodeId`; non-match → `not-found` → overlay (D3) |
| Store file vanishes mid-write | `DatabaseSync` creates a stray empty DB | `exists()` precheck → `no-db`; a stray open's `UPDATE` hits `no such table` → `write-error`, never `ok` → overlay fallback (D2, oracle F6) |
| Double name (overlay + native) | Two competing titles for one entry | On native success clear the overlay (`setCustomName(entryId,"")`); overlay kept only as failure fallback (D3) |
| Codex `session_index.jsonl` stays stale | Codex's own resume/lookup index still shows the old name until Codex rewrites it | ACCEPTED limitation: DB-only. The vault reads `threads.title` (SQLite), which reconcile preserves via `prefer_existing_explicit_title` — so the vault + thread metadata show the new name. Mirroring the JSONL index means appending to an agent-owned append-only file, the exact fragile pattern the safe-location hybrid deliberately avoids (docs/research/20260707-vault-native-rename.md §3). Renaming to a string that exactly equals the first user message is treated by Codex as non-explicit (`distinct_thread_metadata_title` → None) — a rare edge, not handled. |

**Data-Scale**: no new collection, list endpoint, or derived value. The write is a single-row `UPDATE` by primary key (`id`), keyed on an already-bounded session id; growth axis = 1 row per rename action, invariant of store size. The subsequent `refresh()` reuses the existing bounded reader (ROW_LIMIT 500).
