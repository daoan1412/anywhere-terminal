## 1. Shared primitives

- [x] 1_1 Add a WAL-safe live-DB `writeSqlite` helper
  - **Deps**: none
  - **Refs**: design.md D2; design.md Interfaces (`writeSqlite`, `runNodeWrite`); specs/vault-session-rename/spec.md#native-write-safety
  - **Scope**: src/vault/sqlite.ts, src/vault/sqlite.write.test.ts
  - **Acceptance**:
    - Outcome: `writeSqlite(dbPath, "UPDATE t SET title=? WHERE id=?", [name, id])` opens the LIVE db read-write via `node:sqlite`, sets `busy_timeout=5000`, runs the bound UPDATE, returns `{status,changes}`; maps `no-sqlite3` (engine absent), `no-db` (missing file), `not-found` (`changes===0`), `write-error` (throw / `no such table`); never throws
    - Verify: unit src/vault/sqlite.write.test.ts
  - **Plan**:
    1. Add `SqliteWriteStatus`/`SqliteWriteResult`/`SqliteWriteDeps` + `writeSqlite` per design Interfaces; reuse `probeNodeSqlite` for the `hasNodeSqlite` default and `defaultDeps.exists` for existence.
    2. Default `runNodeWrite`: `new DatabaseSync(dbPath)` (read-write), `db.exec("PRAGMA busy_timeout = 5000")`, `db.prepare(sql).run(...params)`, `changes = Number(info.changes)`, close in `finally`; wrap in try/catch → `write-error`.
    3. Tests with injected deps for each status branch, PLUS one REAL round-trip: create a temp sqlite file (via node:sqlite), insert a row, `writeSqlite` UPDATE, re-open and assert the new title persisted + `changes===1`; and an UPDATE matching no row → `not-found`.

- [x] 1_2 Extract a shared `normalizeVaultCustomName`
  - **Deps**: none
  - **Refs**: design.md D3; design.md Interfaces; specs/vault-session-rename/spec.md#name-normalization-and-clearing; VaultCustomNameRegistry.ts:66-74 (private `normalize`, `CUSTOM_NAME_MAX_LENGTH`)
  - **Scope**: src/vault/VaultCustomNameRegistry.ts, src/vault/VaultCustomNameRegistry.test.ts
  - **Acceptance**:
    - Outcome: `normalizeVaultCustomName(input)` and `CUSTOM_NAME_MAX_LENGTH` are exported (trim + cap 80; empty-after-trim → `null`); `VaultCustomNameRegistry.normalize` delegates to it (behavior unchanged)
    - Verify: unit src/vault/VaultCustomNameRegistry.test.ts
  - **Plan**:
    1. Promote the private `normalize` body to an exported `normalizeVaultCustomName(input): string | null`; export `CUSTOM_NAME_MAX_LENGTH`; have the class method call it.
    2. Test trim, >80 cap, whitespace-only → null (extend existing registry test).

## 2. Per-agent native rename writers

- [x] 2_1 Add `renameOpenCodeSession`
  - **Deps**: 1_1
  - **Refs**: design.md D1, D2; design.md Interfaces; opencodeReader.ts (`resolveOpencodePaths`/`opencodeStoreDirs`, `isSafeOpenCodeId`)
  - **Scope**: src/vault/readers/opencodeReader.ts, src/vault/readers/opencodeReader.rename.test.ts
  - **Acceptance**:
    - Outcome: `renameOpenCodeSession(id, name)` resolves the opencode `dbPath`, calls `writeSqlite(dbPath, "UPDATE session SET title = ? WHERE id = ?", [name, id])`, returns true iff a row was updated; returns false for an id failing `isSafeOpenCodeId` (no write attempted)
    - Verify: unit src/vault/readers/opencodeReader.rename.test.ts
  - **Plan**:
    1. Add an injectable `writeSqliteFn?: typeof writeSqlite` to `OpenCodeReaderOptions`; export `renameOpenCodeSession`.
    2. Guard `isSafeOpenCodeId(id)` → false; else `writeSqlite(resolveOpencodePaths(options).dbPath, SQL, [name, id])`; return `status==="ok" && changes>0`.
    3. Tests: injected `writeSqliteFn` asserts SQL + params + dbPath; unsafe id short-circuits (fn never called).

- [x] 2_2 Add `renameCodexThread`
  - **Deps**: 1_1
  - **Refs**: design.md D1, D2, D3 (archived guard); design.md Interfaces; codexReader.ts (`codexDirs`/`codexStoreDirs`, `isSafeCodexId`, `archived = 0` list filter)
  - **Scope**: src/vault/readers/codexReader.ts, src/vault/readers/codexReader.rename.test.ts
  - **Acceptance**:
    - Outcome: `renameCodexThread(id, name)` resolves the codex `dbPath` (`state_5.sqlite`), calls `writeSqlite(dbPath, "UPDATE threads SET title = ? WHERE id = ? AND archived = 0", [name, id])`, returns true iff a row was updated; false for an id failing `isSafeCodexId`
    - Verify: unit src/vault/readers/codexReader.rename.test.ts
  - **Plan**:
    1. Add injectable `writeSqliteFn?: typeof writeSqlite` to `CodexReaderOptions`; export `renameCodexThread`.
    2. Guard `isSafeCodexId(id)`; else `writeSqlite(codexDirs(options).dbPath, SQL_WITH_ARCHIVED_0, [name, id])`; return `status==="ok" && changes>0`.
    3. Tests mirror 2_1 (SQL incl `AND archived = 0` + params + dbPath + unsafe-id short-circuit).

## 3. Service dispatch + fresh refresh

- [x] 3_1 Add `VaultService.writeNativeTitle`
  - **Deps**: 2_1, 2_2
  - **Refs**: design.md D1, D3; VaultService.ts (`setCustomName`, `parseEntryId` — used at getDetail/getEntry)
  - **Scope**: src/vault/VaultService.ts, src/vault/VaultService.test.ts
  - **Acceptance**:
    - Outcome: `writeNativeTitle(entryId, name)` parses the agent via `parseEntryId`, dispatches opencode→`renameOpenCodeSession` / codex→`renameCodexThread`, returns their boolean; returns false for claude/unknown (no write)
    - Verify: unit src/vault/VaultService.test.ts
  - **Plan**:
    1. Reuse `parseEntryId` (agent + sessionId); add injectable rename fns to the service deps for tests (default to the real reader exports).
    2. Switch on agent: opencode/codex → call the writer with sessionId+name; claude/default → return false.
    3. Tests: opencode/codex entry ids dispatch to the (stubbed) writer and propagate its bool; claude/unknown → false, writer never called.

- [x] 3_2 Add a force option to `VaultService.refresh`
  - **Deps**: none
  - **Refs**: design.md D4 (single-flight bypass, oracle F2); VaultService.ts:276-300 (`refresh`, `inflightRefresh`)
  - **Scope**: src/vault/VaultService.ts, src/vault/VaultService.test.ts
  - **Acceptance**:
    - Outcome: `refresh({ force: true })` never joins an in-flight refresh — when one is running it awaits it, then starts and returns a fresh (post-write) read; `refresh()` / `refresh({})` behave exactly as before (join in-flight)
    - Verify: unit src/vault/VaultService.test.ts
  - **Plan**:
    1. Add `opts?: { force?: boolean }`; when `!force` keep the existing `if (this.inflightRefresh) return this.inflightRefresh`.
    2. When `force` and a refresh is in flight, `await this.inflightRefresh` (ignore its result) before building the new `run`, so the fresh read strictly follows the prior one (and the write).
    3. Test: seed an in-flight refresh returning an OLD list; `refresh({force:true})` resolves to a NEW read (the `readAll` stub returns the updated list on the 2nd call).

## 4. Handler routing

- [x] 4_1 Route `handleVaultRenameSession` by agent (normalize → native → fallback)
  - **Deps**: 3_1, 3_2, 1_2
  - **Refs**: design.md D1, D3, D4; design.md Architecture; specs/vault-session-rename/spec.md#user-rename-via-sidecar-registry; specs/vault-session-rename/spec.md#native-title-write-for-sqlite-agents; TerminalViewProvider.ts:500-519 (`handleVaultRenameSession`, `_vaultRefreshSeq`)
  - **Scope**: src/providers/TerminalViewProvider.ts, src/providers/TerminalViewProvider.vaultRename.test.ts
  - **Acceptance**:
    - Outcome: renaming an opencode/codex entry to a non-null normalized name calls `writeNativeTitle`; on success the overlay for that entry is cleared (`setCustomName(entryId,"")`) and `refresh({force:true})` is posted; on native failure it falls back to `setCustomName(entryId,normalized)`; a null (empty) name or a claude/unknown agent uses the existing overlay path unchanged
    - Verify: unit src/providers/TerminalViewProvider.vaultRename.test.ts
  - **Plan**:
    1. In `handleVaultRenameSession`, `const norm = normalizeVaultCustomName(name)`; parse agent from entryId.
    2. If agent∈{opencode,codex} AND `norm !== null`: `const ok = await writeNativeTitle(entryId, norm)`; if ok → `setCustomName(entryId,"")` + `refresh({force:true})`+post (via `_vaultRefreshSeq`); else → `setCustomName(entryId,norm)` then existing listCached/refresh post.
    3. Else (claude/unknown, or `norm===null`) → existing `setCustomName(entryId, norm ?? "")` + listCached/refresh path unchanged.
    4. Tests: stub `writeNativeTitle`/`setCustomName`/`refresh`/`listCached`; assert each branch — native ok (overlay cleared + `refresh({force:true})`), native fail (overlay set to normalized), empty-name clear (opencode → overlay cleared, no write), claude overlay, and an over-long name is capped before the native write.
