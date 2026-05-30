# Code Review — round 1 (cache-vault-load)

Date: 2026-05-29. Reviewers: asm-review-data-security, asm-review-logic, asm-review-frontend, asm-oracle
(plus an earlier oracle review of the PLAN, whose 6 findings were all applied before build).

Verification at review time: `tsc --noEmit` clean; `pnpm run test:unit` 1807/1807 pass; Biome clean on changed files.

## Findings + triage

| # | Severity | Source | Finding | Disposition |
|---|---|---|---|---|
| 1 | BLOCKER | oracle | SQLite reader cache reuse returned `unreadable: 0`; a `query-error` was cached (non-empty `sources`) and reused as an empty SUCCESS on the next refresh, silently dropping the partial-failure notice. | **ACCEPTED + FIXED.** Added `unreadable` to the `store` cache variant (carried on reuse); a `query-error` now caches EMPTY `sources` so it is retried, never reused as success. codexReader.ts / opencodeReader.ts / cacheTypes.ts. Tests added. |
| 2 | SHOULD-FIX | data-security + oracle | Cross-window temp-file collision: `tempCounter` is per-instance but `globalStorageUri` is shared by every VS Code window → two windows both write `list.json.tmp.1`, racing the rename (lost write / ENOENT). | **ACCEPTED + FIXED.** Temp name now `list.json.tmp.<pid>.<counter>` (unique across processes + within one). VaultCacheStore.ts. |
| 3 | SHOULD-FIX | data-security | No orphan-temp cleanup; a crash between write and rename leaks owner-readable temp files holding titles+cwds forever. | **ACCEPTED + FIXED.** Added `VaultCacheStore.cleanupOrphanTemps()`, called once on activate (extension.ts), mirroring SessionStorage. |
| 4 | SHOULD-FIX | frontend | `activePreviewEntry` not refreshed when the render is skipped → preview re-render paths could read a stale entry object. | **ACCEPTED + FIXED.** `render()` refreshes `activePreviewEntry` from the new entries even when the DOM re-render is skipped. VaultPanel.ts. |
| 5 | SHOULD-FIX | frontend | `lastRenderSig` not reset on collapse → a future scenario could skip the first paint after re-expand. | **ACCEPTED + FIXED.** `lastRenderSig` reset to null on the collapsed→expanded transition. VaultPanel.ts. |
| 6 | SHOULD-FIX | logic (re-run) | Cached response used `safeSendWithRetry`; a retried cache post could land AFTER the fresh response and make a stale list win (the latest-wins token only guarded the fresh post). | **ACCEPTED + FIXED.** Cached (`fromCache:true`) response now uses best-effort `safePostMessage` (no retry); the authoritative fresh response keeps retry. TerminalViewProvider.ts. |
| 7 | P4 / NICE | logic (re-run) | `lastRenderSig` only updated in `render()`, so a local UI render (search/filter/group via `renderList` directly) left the key stale → next unchanged host response would churn the DOM. | **ACCEPTED + FIXED.** Extracted `currentSignature()`; `renderList()` now updates `lastRenderSig` on every paint, so the guard always reflects the actual DOM. VaultPanel.ts. |
| 8 | NICE | data-security + oracle | `load()` validated only top-level shape; a garbled `entries[]` element could reach the webview and throw. | **ACCEPTED + FIXED.** Added per-entry shape validation + `unreadable.reasons` array check; any malformed element voids the whole cache → full rebuild. VaultCacheStore.ts. |
| 9 | NICE | frontend | `result.unreadable` not consumed by `render()` → an unreadable-count badge (if wired) wouldn't update. | **REBUTTED (pre-existing, out of scope).** `render()` never consumed `result.unreadable` before this change; `unreadable` is unused in VaultPanel.ts today. Not a regression; unrelated to caching. |

## Verified by reviewers (no action)

- D5 privacy mitigation (0o600 / globalStorageUri / no egress) is sound and consistent with SessionStorage; a poisoned cache cannot reach a filesystem sink (all actions re-resolve paths by id host-side through the UNCACHED `list()`/`getEntry()`).
- `(mtimeMs,size)` on `.db`+`-wal` (excluding `-shm`) is a correct SQLite freshness signal (no false "unchanged").
- Single-flight `refresh()` + awaited `save()` serialize writes within a process; `inflightRefresh` clears on success and throw.
- Per-provider latest-wins token correctly drops a stale FRESH response over the shared single-flight refresh.
- `readAll` partial-failure omits the failed agent from the cache (no stale resurrection).
- The in-place `canFork` resolution aliasing the cached entries is intentional and harmless (re-resolved each refresh; JSON round-trip breaks aliasing on reload).
- All 6 prior plan-review fixes confirmed present in code.

## Test-stability note (not a review finding)

During the verify gate the full suite flaked ~1/5 in `VaultPanel.test.ts` (never in isolation). Root cause:
pre-existing test hygiene — `createHost()` appends to `document.body` and previews attach document-level
listeners, with no cleanup between tests; surfaced only under full-suite scheduling. Fixed by a file-wide
`afterEach` that closes any open preview (Escape) and clears `document.body`. Verified 10/10 full-suite runs
green afterward. My production code was not the cause (the flaky test calls `render()` once and does not
re-enter the guard).

## Final state

`tsc` clean · Biome clean · `pnpm run test:unit` 1807/1807 pass · 10/10 full-suite runs stable.
No open BLOCKER/SHOULD-FIX. Two NICE items rebutted/closed.
