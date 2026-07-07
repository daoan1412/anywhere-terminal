---
labels: [sqlite, database, write, wal, vscode-api, nodesqlite]
source: write-vault-rename-to-store
summary: The SQLite read path copies the DB to temp for safety; writes must open the live DB read-write with busy_timeout. Using node:sqlite DatabaseSync with PRAGMA busy_timeout=2000 for WAL tolerance.
---
# SQLite write path must open the LIVE database, not a temp copy
**Date**: 2026-07-07

## TL;DR
- Read path copies DB + WAL sidecars to temp, queries the copy (safety: isolates live writes)
- Write path MUST open the **LIVE** DB read-write via `node:sqlite` `DatabaseSync`
- Set `PRAGMA busy_timeout = 2000ms` to survive transient WAL write locks
- Parameterized UPDATE only; no string concatenation for user input

## Context
VS Code extension vault reads SQLite stores from OpenCode, Codex, and Claude. The read mechanism copies the live DB + `-wal`/`-shm` sidecars into a temp dir and queries the copy — this avoids corruption risks when an agent is writing and ensures a consistent snapshot. A read-only open of a live WAL database can silently return empty results instead of erroring, which would be indistinguishable from a genuinely-empty session.

When implementing a native write (e.g., renaming a session title directly in an agent's store), the write must use a **separate path** that opens the live DB, because a write to the temp copy is discarded.

## Evidence
### Anchors
- `src/vault/sqlite.ts` → comments lines 14-19 explain the copy-to-temp snapshot strategy for reads
- `src/vault/sqlite.ts` → `defaultRunNodeWrite()` lines 354-378: opens live DB with `new DatabaseSync(dbPath)` (line 366), sets `PRAGMA busy_timeout = 2000` (line 368)
- `src/vault/readers/opencodeReader.ts` → `renameOpenCodeSession()` calls `writeSqlite(dbPath, "UPDATE session SET title = ? WHERE ...", [name, id])`
- `src/vault/readers/codexReader.ts` → `renameCodexThread()` calls `writeSqlite(dbPath, "UPDATE threads SET title = ? WHERE ...", [name, id])`

## When to apply
- Implementing any new write operation against an agent's SQLite store
- First sign: "I'll reuse the read path for the write" → WRONG, separate path needed
- Grounding: check if your fs.copy() / temp-clone is involved; if so, you're on the read path and must diverge for writes
