# Design: cache-vault-load

## Decisions

### D1: Stale-while-revalidate — serve cache instantly, then refresh

`TerminalViewProvider.handleRequestVaultSessions` becomes two-phase: synchronously load the persisted cache
and, if present, post a `vaultSessionsResponse` with `fromCache: true` *before* touching any store; then run
an incremental refresh and post a second `vaultSessionsResponse` with `fromCache: false`. No cache → one
full-read response (today's behavior). This is the smallest change that makes display independent of scan
latency while keeping on-disk stores authoritative.

Rejected: blocking the first response on a "quick" partial scan — there is no cheap partial; the 64 KB
per-file tail read is the cost, so anything that reads files is slow. Only a pre-persisted list is instant.

### D2: Cache owned by `VaultService` (shared singleton), persisted via injected `VaultCacheStore`

The sidebar and panel providers share ONE `VaultService` (`extension.ts:122`). The cache and its in-memory
copy live in `VaultService` so both providers see one cache and refreshes coalesce. `VaultService` gains an
optional `cacheStore` dep (a `VaultCacheStore`); when absent (existing unit tests) it behaves as today
(stateless full reads). New methods:

- `listCached(): VaultListResult | null` — return the in-memory cache (lazy-loaded from `cacheStore` on
  first call); null when none.
- `refresh(): Promise<VaultListResult>` — **single-flight**: if a refresh is in flight, return that same
  promise; otherwise run an incremental read against the in-memory per-agent state, update memory, then
  **`await cacheStore.save(...)` before resolving** (oracle: not `void` — single-flight + awaited save
  serializes writes so a later refresh can never persist before an earlier one finishes and overwrite it
  with stale data), and return the fresh result. A save failure is caught/logged and does not fail the
  refresh (the fresh list is still returned and shown).
- `list()` is kept (a full, non-persisted read, `prev = undefined`) for `resolveVaultEntry` and existing
  callers/tests; it and `refresh()` share one private `readAll(prev)`.

Scope: `globalStorageUri`, not workspace `storageUri` — agent session stores are machine-global (one set of
`~/.claude`, `~/.codex`, `opencode.db` per user), so the cache is correct across all windows/workspaces.

### D3: Change detection by `(mtimeMs, size)`; per-file for Claude, per-store for SQLite

The list readers gain an incremental signature `(prev?: ReaderListCache) => Promise<ReaderResultWithState>`
(see Interfaces). The detail and single-entry readers are unchanged.

- **Claude** (`readClaudeSessions`): enumerate files as today; for each, `fs.stat` for `(mtimeMs, size)`;
  if `prev` has that path with the same stamp, reuse `prev`'s entry (skip `parseClaudeFile` **and**
  `readLatestAiTitle` — the 64 KB tail read, which is the whole win); else rebuild via `buildClaudeEntry`.
  Per-session-file granularity: only the sessions you actually used since last open get re-read.
- **Codex / OpenCode**: stat `dbPath` and `dbPath + "-wal"` (resolved by the existing `codexDirs` /
  opencode path resolver). If all present stamps match `prev`, reuse `prev`'s entries wholesale — skipping
  the snapshot clone and the `LIMIT 500` query entirely. Else run the existing query and rebuild. Whole-
  store granularity is right here: the clone+query is the unit cost, and a single DB mtime change can touch
  many rows. The JSONL fallback path (DB absent) has no cheap stamp → always re-read (rare/degraded path).

Correctness note (oracle): stamp the `.db` and its `-wal` only — **not** `-shm` (volatile wal-index/lock
state, not durable content; would cause false invalidations). A WAL write may leave the `.db` mtime
untouched and reuse the `-wal` file at the same size, but it changes the `-wal` mtime, which the stamp
captures. The residual edge case — a same-size, same-mtime in-place edit — is accepted; it self-heals on
the next change and on any cache-miss full rebuild.

`canFork` is resolved by `VaultService` after the merge as today, so a reused entry's cached `canFork` is
overwritten — caching it is harmless.

### D4: Persistence mirrors `SessionStorage` — atomic, versioned, owner-only

`VaultCacheStore(globalStorageUri, fs: FsLike)` writes `<globalStorageUri>/vault-cache/list.json`:
- `save()` async: `mkdir` (`0o700`) → write `list.json.tmp.<n>` (`0o600`) → `rename` (atomic on same FS).
- `load()` sync (`readFileSync` + `JSON.parse`) for the fastest first response; `version !== 1`, parse
  error, or missing file → return `null` (cache miss). Mirrors `SessionStorage.loadIndexDetailed` (D17:
  sidecar is the only source; no second source to disagree).

Multi-window: both windows may write the shared file; atomic rename prevents torn reads and last-writer-wins
is fine for a non-authoritative cache (content converges to the same on-disk truth).

### D5: PRIVACY — caching the bounded title at rest (reverses prior "no persist/cache")  ⚠ REVIEW

The previous posture (`agent-session-index`) forbade persisting/caching the title because it may carry
sensitive user content. This change persists the bounded (≤120-char, newline-stripped) title to the cache,
because the title is the expensive-to-derive value and must be cached to display instantly. Mitigation,
matching the codebase's own established posture:
- File mode `0o600` (owner-only) + dir `0o700` — identical to `SessionStorage`, which already persists raw
  ANSI terminal scrollback (strictly more sensitive — can include echoed credentials) at `0o600` ([W5]).
  **POSIX only (round-2 F-Win):** on Windows, Node's `mode` argument does NOT set an owner-only ACL — the
  file inherits the parent `globalStorageUri` (user-profile) ACLs instead. So the at-rest boundary on
  Windows is "whatever the user profile grants", not an enforced `0o600`. This matches `SessionStorage`'s
  identical POSIX-only behavior; the claim is not that the mode bit protects the file on Windows.
- Stored only under the extension's `globalStorageUri`; **never** transmitted off the machine (the existing
  no-egress requirement is preserved verbatim).
- Only the already-IPC-exposed bounded title + metadata are cached — no message bodies.

Honest scope of the mitigation (oracle): `0o600` is **owner-readable**, not extension-private — any process
or extension running as the same OS user can read the file, and a user-configured system/cloud backup may
copy it. The cached `VaultSessionEntry` also includes absolute `cwd`, `sessionPath`, and sometimes
`flags.configDir`, which can leak usernames / project / customer names independently of the title. This is
accepted as equivalent to the existing `SessionStorage` exposure (which persists far more), but it is a real
broadening of what sits on disk and is the decision a human reviewer must explicitly accept (Gate-2 summary).

Rejected: caching everything *except* the title and re-deriving titles on open — defeats the purpose, since
the title tail-read is the dominant cost.

### D6: Webview no-op render guard — "only update new data" at the UI

`VaultPanel.render(result)` computes a cheap signature over the ordered entries covering **every
field the row, the folder filter, and the row actions read** — `id`, `agent`, `title`, `cwd`, `modified`,
`canFork`, `sessionPath`, and `flags` — not just `id`/`modified`/`title`. (Oracle: a narrow signature would
hide a `canFork` flip — recomputed by `VaultService` on each refresh, e.g. after an OpenCode version change
— or a `cwd` change that affects the folder filter.) If the signature equals the last rendered one, `render`
returns without touching the DOM; otherwise it updates `this.entries` and re-renders. `this.entries` is
always kept current so client-side search/filter never operates on stale data even when the DOM is untouched.
This makes an unchanged refresh invisible (preserving an open preview, scroll, and selection) while never
masking a real change.

### D7: Latest-wins on the host response

`handleRequestVaultSessions` captures a per-provider refresh token before awaiting `refresh()`; if a newer
request superseded it, the stale fresh response is dropped (mirrors the existing detail-response stale guard,
`handleRequestVaultSessionDetail`). Prevents an out-of-order refresh from overwriting a newer one.

## Interfaces

```ts
// src/vault/cacheTypes.ts (new) — shared, JSON-serializable.

/** One backing file's identity for change detection. */
export interface FileStamp { mtimeMs: number; size: number; }

/** Per-agent persisted freshness state (opaque to VaultService; shaped per reader). */
export type ReaderListCache =
  // Claude: one stamp + entry per session file (per-file reuse granularity).
  | { kind: "files"; files: Record<string /*absPath*/, { stamp: FileStamp; entry: VaultSessionEntry }> }
  // Codex / OpenCode: stamps for the store file(s) + the cached entries (whole-store reuse).
  | { kind: "store"; sources: Record<string /*absPath*/, FileStamp>; entries: VaultSessionEntry[] };

/** What a list reader returns under the incremental contract. */
export interface ReaderResultWithState {
  entries: VaultSessionEntry[];
  unreadable: number;
  cache: ReaderListCache;
}

// Back-compat (oracle): the EXPORTED readers stay option-first and gain an optional 2nd `prev` param —
// `readClaudeSessions(options?, prev?)` etc. — so existing callers/tests that pass options keep working,
// and the return type widens from `ReaderResult` to `ReaderResultWithState` (adds `cache`; existing
// destructurers of `{entries,unreadable}` are unaffected). `VaultService`'s internal reader map adapts to
// the prev-only shape below: `claude: (prev) => readClaudeSessions({}, prev)`.
export type ListReader = (prev?: ReaderListCache) => Promise<ReaderResultWithState>;

/** Persisted cache document. */
export interface VaultListCacheFileV1 {
  version: 1;
  savedAt: number; // epoch ms, informational
  agents: Partial<Record<VaultAgentId, ReaderListCache>>;
  entries: VaultSessionEntry[];               // merged + sorted snapshot for instant render
  unreadable: { count: number; reasons: string[] };
}

// src/vault/VaultCacheStore.ts (new)
export class VaultCacheStore {
  constructor(globalStorageUri: vscode.Uri, fs: FsLike);   // FsLike from SessionStorage
  load(): VaultListCacheFileV1 | null;                     // sync; null on miss/corrupt/version-mismatch
  save(doc: VaultListCacheFileV1): Promise<void>;          // async, atomic temp+rename, 0o600
}
```

IPC: `VaultSessionsResponseMessage` gains `fromCache?: boolean` (`src/types/messages.ts`).

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `VaultCacheStore` (privacy) | Bounded title persisted at rest may carry sensitive content | `0o600`/`0o700`, `globalStorageUri` only, no egress; mirrors `SessionStorage` [W5]; MODIFY spec + D5 flagged for human accept (task 7_2 oracle) |
| `VaultService.refresh` | Stale cache shown until refresh lands | Always refresh on open; incremental → fast; D6 no-op guard makes an unchanged refresh invisible; staleness ≤ one open |
| `VaultPanel.render` | Re-render drops open preview / scroll on every refresh | D6 signature guard: re-render only when entries changed; preview overlay is separate DOM |
| Readers (incremental) | mtime granularity misses a same-size in-place edit | stamp includes `size`; SQLite stamps `db`+`-wal`; self-heals on next change; re-expand forces a full path when cache absent |
| `VaultCacheStore.load` | Torn/corrupt/old-version file crashes or serves garbage | `try/catch` + `version === 1` guard → return null → full rebuild (mirrors `loadIndexDetailed`) |
| Multi-window | Two windows write the shared cache file | Atomic temp+rename; last-writer-wins acceptable for a non-authoritative cache |
| Reader signature change | Breaks `getEntry` / `getDetail` / existing tests | Only the 3 LIST readers change; entry/detail reader maps untouched; `VaultService.list()` retained as full-read wrapper |
| `handleRequestVaultSessions` | Out-of-order refresh overwrites newer list | D7 latest-wins token (mirrors existing detail stale guard) |
