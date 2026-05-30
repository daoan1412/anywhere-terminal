# Tasks: cache-vault-load

## 1. Cache foundation

- [x] 1_1 Define cache types + `VaultCacheStore`
  - **Deps**: none
  - **Refs**: specs/vault-list-cache/spec.md#requirement-persisted-cache-location-format-and-recovery; specs/vault-list-cache/spec.md#requirement-cache-is-local-only-and-bounded; design.md D4; src/session/SessionStorage.ts (FsLike + atomic temp+rename + version-guard pattern)
  - **Scope**: src/vault/cacheTypes.ts (new), src/vault/VaultCacheStore.ts (new), src/vault/VaultCacheStore.test.ts (new)
  - **Acceptance**:
    - Outcome: `VaultCacheStore.load()` returns `null` for missing / unparseable / `version !== 1` files and round-trips a valid v1 doc; `save()` writes `<globalStorageUri>/vault-cache/list.json` via `mkdir(0o700)` + temp(`0o600`) + `rename`.
    - Verify: unit src/vault/VaultCacheStore.test.ts
  - **Plan**:
    1. Add `cacheTypes.ts`: `FileStamp`, `ReaderListCache`, `ReaderResultWithState`, `VaultListCacheFileV1` (per design.md Interfaces).
    2. Add `VaultCacheStore(globalStorageUri, fs: FsLike)` reusing `FsLike` from SessionStorage; `load()` sync `readFileSync`+`JSON.parse` wrapped in try/catch with `version===1` guard → else `null`; `save()` async `mkdir`→write temp→`rename`.
    3. Tests with a fake `FsLike`: round-trip, missing→null, bad JSON→null, `version:2`→null, assert temp+rename order and `0o600` mode arg.

## 2. Incremental list readers

- [x] 2_1 Make the Claude list reader incremental (per-session-file stamp)
  - **Deps**: 1_1
  - **Refs**: specs/vault-list-cache/spec.md#requirement-incremental-refresh-of-changed-sources-only; specs/vault-list-cache/spec.md#requirement-deletion-and-edit-reconciliation; design.md D3; src/vault/readers/claudeReader.ts:532 (readClaudeSessions), :501 (buildClaudeEntry), :64 (readLatestAiTitle)
  - **Scope**: src/vault/readers/claudeReader.ts, src/vault/readers/claudeReader.test.ts
  - **Acceptance**:
    - Outcome: `readClaudeSessions(options?, prev?)` (option-first preserved) returns `ReaderResultWithState`; a file whose `(mtimeMs,size)` matches `prev` reuses the cached entry WITHOUT re-reading the file body (no metadata stream, no 64 KB AI-title tail read); changed or new files are rebuilt; files absent from disk are dropped from the returned cache.
    - Verify: unit src/vault/readers/claudeReader.test.ts
  - **Plan**:
    1. Add an optional 2nd param `prev?: ReaderListCache` (kind `"files"`) — keep `options` first for back-compat; widen the return type to `ReaderResultWithState`. Keep the dir/file enumeration.
    2. In the file loop, `fs.stat` each path for `{mtimeMs,size}`; if `prev.files[path].stamp` matches, push the reused entry; else `buildClaudeEntry`.
    3. Build the new `files` map from current paths only; return `{ entries, unreadable, cache: { kind: "files", files } }`.
    4. Tests (oracle: `parseClaudeFile`/`readLatestAiTitle` are private — do NOT spy them): use a temp-dir or fake-fs fixture and assert reuse by behavior — a reused file's *content* is never opened (e.g. point `prev`'s stamp at a file whose body would yield a different title, and assert the cached title is returned unchanged); plus changed-mtime re-reads, deleted file dropped, and fresh (no `prev`) equals today's output.

- [x] 2_2 Make the Codex list reader incremental (store-file stamp)
  - **Deps**: 1_1
  - **Refs**: specs/vault-list-cache/spec.md#requirement-incremental-refresh-of-changed-sources-only; design.md D3; src/vault/readers/codexReader.ts:216 (codexDirs), :41 (CODEX_THREADS_SQL), readCodexSessions
  - **Scope**: src/vault/readers/codexReader.ts, src/vault/readers/codexReader.test.ts
  - **Acceptance**:
    - Outcome: `readCodexSessions(options?, prev?)` (option-first preserved) returns `ReaderResultWithState`; when the `state_5.sqlite` (+ `-wal`) `(mtimeMs,size)` stamps match `prev`, returns `prev` entries WITHOUT invoking `readSqliteFn`; otherwise queries and rebuilds; the JSONL-fallback path re-reads each time.
    - Verify: unit src/vault/readers/codexReader.test.ts
  - **Plan**:
    1. Add optional 2nd param `prev?`; resolve `dbPath` via `codexDirs`; `fs.stat` `dbPath` and `dbPath + "-wal"` (ignore ENOENT → omit; do NOT stamp `-shm`).
    2. If `prev.kind === "store"` and current `sources` deep-equal `prev.sources`, return `prev.entries` + same sources (skip `readSqliteFn`).
    3. Else run the existing query; build entries + `sources`; return `{ ..., cache: { kind: "store", sources, entries } }`.
    4. Tests: unchanged stamps → injected `readSqliteFn` NOT called; changed `-wal` mtime → called and rebuilt.

- [x] 2_3 Make the OpenCode list reader incremental (store-file stamp)
  - **Deps**: 1_1
  - **Refs**: specs/vault-list-cache/spec.md#requirement-incremental-refresh-of-changed-sources-only; design.md D3; src/vault/readers/opencodeReader.ts:125 (db path resolver), readOpenCodeSessions
  - **Scope**: src/vault/readers/opencodeReader.ts, src/vault/readers/opencodeReader.test.ts
  - **Acceptance**:
    - Outcome: `readOpenCodeSessions(options?, prev?)` (option-first preserved) returns `ReaderResultWithState`; matching `opencode.db` (+ `-wal`) stamps reuse `prev` entries WITHOUT `readSqliteFn`; else query + rebuild.
    - Verify: unit src/vault/readers/opencodeReader.test.ts
  - **Plan**:
    1. Add optional 2nd param `prev?`; mirror 2_2 using the opencode `dbPath` resolver (stamp `.db` + `-wal`, not `-shm`).
    2. Same stamp-compare → reuse-or-query branch.
    3. Tests parallel to 2_2.

## 3. Service orchestration

- [x] 3_1 Add cache + incremental orchestration to `VaultService`
  - **Deps**: 2_1, 2_2, 2_3
  - **Refs**: specs/vault-list-cache/spec.md#requirement-instant-cached-list-on-open; specs/vault-list-cache/spec.md#requirement-deletion-and-edit-reconciliation; design.md D2, D7; src/vault/VaultService.ts:82
  - **Scope**: src/vault/VaultService.ts, src/vault/VaultService.test.ts
  - **Acceptance**:
    - Outcome: `VaultService` accepts an optional `cacheStore`; `listCached()` returns the lazily-loaded persisted list or `null`; `refresh()` is single-flight, runs the incremental read against the in-memory per-agent state, persists via `cacheStore`, and returns the merged+sorted+fork-resolved result; `list()` is retained as a full (non-persisted) read; with no `cacheStore` behavior is unchanged from today.
    - Verify: unit src/vault/VaultService.test.ts
  - **Plan**:
    1. Change `VaultReaders` to the `ListReader` (`(prev?) => ReaderResultWithState`) signature; update `defaultReaders` to adapt the option-first exports: `claude: (prev) => readClaudeSessions({}, prev)`, etc.
    2. Extract `private readAll(prev?)` from `list()` (allSettled → merge → fork-resolve → sort) returning `{ entries, unreadable, cache }`.
    3. Add `cacheStore?` dep + `private mem: VaultListCacheFileV1 | null`; `listCached()` lazy-loads via `cacheStore.load()`; `refresh()` memoizes the in-flight promise (single-flight), updates `mem`, then **`await cacheStore.save(...)`** (try/catch — a save error is logged, not thrown) before resolving.
    4. `list()` returns `readAll(undefined)` projected to `{entries,unreadable}` (no persist).
    5. Tests: refresh persists + returns sorted; a second refresh passes prev per-agent cache to readers (reuse); two concurrent `refresh()` calls share one promise AND produce exactly one `save`; a removed source drops its entry; a save rejection still resolves refresh with the fresh list; no-`cacheStore` parity with old `list()`.

## 4. Host wiring + IPC

- [x] 4_1 Construct `VaultService` with a `VaultCacheStore`
  - **Deps**: 1_1, 3_1
  - **Refs**: design.md D2; src/extension.ts:122 (vaultService construction); src/extension.ts:2 (node fs import)
  - **Scope**: src/extension.ts
  - **Acceptance**:
    - Outcome: `vaultService` is constructed with `new VaultCacheStore(context.globalStorageUri, fs)` (the same `node:fs` used elsewhere in activate).
    - Verify: manual `pnpm run check-types` passes
  - **Plan**:
    1. Build `new VaultCacheStore(context.globalStorageUri, fs)` and pass it as `{ cacheStore }` to `new VaultService({ cacheStore })`.

- [x] 4_2 Two-phase host response (cached → fresh) with `fromCache` + latest-wins
  - **Deps**: 3_1
  - **Refs**: specs/vault-list-cache/spec.md#requirement-instant-cached-list-on-open; design.md D1, D7; src/providers/TerminalViewProvider.ts:321 (handleRequestVaultSessions); src/types/messages.ts:888 (VaultSessionsResponseMessage)
  - **Scope**: src/types/messages.ts, src/providers/TerminalViewProvider.ts
  - **Acceptance**:
    - Outcome: when `listCached()` is non-null the handler posts `vaultSessionsResponse {fromCache:true}` BEFORE any refresh, then posts the refreshed `{fromCache:false}`; a refresh superseded by a newer request is dropped; with no cache exactly one response is posted. `VaultSessionsResponseMessage` carries optional `fromCache`.
    - Verify: manual `pnpm run check-types` (no provider unit harness exists; logic covered by 3_1)
  - **Plan**:
    1. Add `fromCache?: boolean` to `VaultSessionsResponseMessage`.
    2. In the handler: `const cached = this.vaultService.listCached(); if (cached) post {type:"vaultSessionsResponse", result: cached, fromCache: true};`
    3. `const token = ++this._vaultRefreshSeq; const fresh = await this.vaultService.refresh(); if (token !== this._vaultRefreshSeq) return; post {..., result: fresh, fromCache: false};`
    4. Preserve the existing try/catch error response.

## 5. Webview render guard

- [x] 5_1 No-op render guard in `VaultPanel` ("only update new data" at the UI)
  - **Deps**: 4_2
  - **Refs**: specs/vault-list-cache/spec.md#requirement-no-re-render-when-nothing-changed; design.md D6; src/webview/vault/VaultPanel.ts:733 (render); src/webview/main.ts:631 (onVaultSessionsResponse)
  - **Scope**: src/webview/vault/VaultPanel.ts, src/webview/vault/vaultRenderSignature.ts (new), src/webview/vault/vaultRenderSignature.test.ts (new)
  - **Acceptance**:
    - Outcome: a pure `entriesSignature(entries)` over ordered entries covering ALL rendered/filter/action fields (`id, agent, title, cwd, modified, canFork, sessionPath, flags`) exists; `VaultPanel.render` ALWAYS updates `this.entries`, but skips the DOM re-render (`renderList`) when the new signature equals the last rendered one, and re-renders when it differs.
    - Verify: unit src/webview/vault/vaultRenderSignature.test.ts
  - **Plan**:
    1. Add pure `entriesSignature(entries)` helper (DOM-free) hashing the ordered, action-relevant fields (oracle: NOT just id/modified/title — must catch a `canFork` flip or a `cwd` change that affects the folder filter).
    2. In `render`, compute the signature; always set `this.entries` (so client-side search/filter never see stale data); if the signature equals `this.lastRenderSig`, return without calling `renderList`; else `renderList()` + store the signature.
    3. Tests: identical entries → equal signature; a change in any covered field (incl. `canFork`, `cwd`) or in order → different signature.
