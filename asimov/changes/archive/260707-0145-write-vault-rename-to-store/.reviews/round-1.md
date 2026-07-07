# Review: write-vault-rename-to-store — Round 1

- **Date**: 2026-07-07
- **Input**: change-id (working tree, `git diff HEAD` + untracked test files)
- **Reviewable lines**: ~226 added/modified across 6 production files (well under 800)
- **Agents spawned**: data-security, logic, contracts, performance (frontend skipped — no React/webview/client files)
- **Verdict**: **WARN** — 0 BLOCK, 2 WARN, 3 SUGGEST
- **Gates**: `pnpm run check-types` clean; 61 change tests pass (incl. real `node:sqlite` on-disk round-trip).

## Verdict rationale
Well-designed, well-tested change with an unusually thorough design doc that pre-empted most concerns (oracle F1–F6 all addressed; injection prevented via bound params; id guards + Codex `archived=0` scope; force-refresh ordering; shared normalization). Two should-fix WARNs remain: an unscoped OpenCode write boundary (asymmetric with Codex) and a concurrent force-refresh interleave. Neither reaches BLOCK (both bounded, cosmetic/self-correcting impact).

## Findings

### [W1] Two concurrent `refresh({force:true})` calls interleave — single-flight broken
- **Severity**: WARN | **Confidence**: MEDIUM | **Priority**: P2 | **Agent**: logic
- **File**: `src/vault/VaultService.ts:321-346`
- **Evidence**: After `await this.inflightRefresh.catch(() => {})` (321) the method does not re-check `this.inflightRefresh` before building `run` and assigning `this.inflightRefresh = run` (338). With in-flight `A` and two force callers `B`,`C`: both await `A`, then `B` sets `inflightRefresh=runB`, `C` clobbers with `runC`; both runs execute `readAll`→`this.mem=doc`→`cacheStore.save(doc)` concurrently. Reachable when a user renames two OpenCode/Codex sessions (or double-fires one) in quick succession.
- **Impact**: Violates the documented invariant "a later refresh can never persist ahead of an earlier one" (comment VaultService.ts:308-310). Bounded: `save` is atomic temp+rename; both reads are post-write so titles stay correct; worst case is one out-of-order-but-valid cache write that self-corrects next refresh. Hence WARN, not BLOCK.
- **Fix**: After awaiting the prior in-flight in the force branch, re-check/loop on `this.inflightRefresh` (await whatever is now current) before starting a new `run`, or serialize force refreshes through a single chained promise.
- **Status**: accepted → **fixed** | **Triage**: Accepted. Replaced the single `await` with a `while (this.inflightRefresh) await …` drain so force reads serialize (VaultService.ts). Test added: "two concurrent force refreshes serialize" asserts `maxActive===1`.

### [W2] OpenCode native rename can update hidden child/subagent sessions
- **Severity**: WARN | **Confidence**: HIGH | **Priority**: P3 | **Agent**: data-security
- **File**: `src/vault/readers/opencodeReader.ts:214`
- **Evidence**: The OpenCode list query exposes only root sessions (`WHERE s.parent_id IS NULL OR s.parent_id = ''`), but the native write is scoped only by `id = ?` (`UPDATE session SET title = ? WHERE id = ?`) — no root/archived filter, unlike Codex's `AND archived = 0`. Any regex-safe (`/^[A-Za-z0-9_-]+$/`) webview-supplied `sessionId` is accepted.
- **Impact**: A forged/stale `opencode:<child-session-id>` can mutate the live title of a child/subagent row the vault never exposed for rename; because the UPDATE succeeds, the overlay fallback is skipped. Impact ceiling is **low/cosmetic** — a title-text change on a hidden row, no data loss / cross-user / escalation. Design D3 addressed the *stale* case ("children never listed as roots") but not the *forged* case; the boundary is unenforced at the write.
- **Fix**: Scope the OpenCode update to the list's visibility boundary, e.g. `... WHERE id = ? AND (parent_id IS NULL OR parent_id = '')` (mirroring Codex's scoping), or verify rename-eligibility before the native call.
- **Status**: accepted → **fixed** | **Triage**: Accepted. Scoped the UPDATE to `AND (parent_id IS NULL OR parent_id = '')` (opencodeReader.ts), mirroring the list + Codex's `archived=0`. Test SQL assertion updated. Design D3 updated to record the enforced guard.

### [S1] Normalization contract asymmetric across `writeNativeTitle` vs `setCustomName`
- **Severity**: SUGGEST | **Confidence**: MEDIUM | **Priority**: P4 | **Agent**: contracts
- **File**: `src/vault/VaultService.ts:172` (`writeNativeTitle`) vs `:161` (`setCustomName`)
- **Evidence**: `setCustomName` normalizes internally (registry `normalize`), but `writeNativeTitle` writes `name` straight to `renameX`→`UPDATE ... SET title = ?` with no trim/cap. The trim+cap invariant lives only in the single caller `handleVaultRenameSession` (TerminalViewProvider.ts:510→517), not in the public API whose doc comment claims "same trim + cap" (VaultCustomNameRegistry.ts:12-16).
- **Impact**: A future second caller of `writeNativeTitle`/`renameCodexThread`/`renameOpenCodeSession` that forgets to pre-normalize writes an untrimmed/uncapped title, silently diverging from the overlay guarantee. Low severity today (single caller; agent `title` column has no length constraint → display-consistency gap, not corruption).
- **Fix**: Apply `normalizeVaultCustomName` inside `writeNativeTitle` (or each reader `renameX`) so the invariant is self-enforcing; or add an explicit `@param name` "caller must pass a normalized name" note.
- **Status**: accepted → **fixed** | **Triage**: Accepted. `writeNativeTitle` now normalizes (trim+cap) internally and returns false on empty — self-enforcing regardless of caller. Test added ("normalizes … before dispatching, and rejects empty").

### [S2] Native-rename success drops the webview response when `refresh` throws
- **Severity**: SUGGEST | **Confidence**: MEDIUM | **Priority**: P4 | **Agent**: logic
- **File**: `src/providers/TerminalViewProvider.ts:527-534`
- **Evidence**: On native-write success, if `refresh({force:true})` throws, the `catch` logs and `return`s with no `vaultSessionsResponse` posted — unlike the overlay path which has a cached-post fallback.
- **Impact**: Webview gets no reply to its rename that beat; title is already persisted + overlay cleared, so it surfaces only when the store watcher's auto-refresh next fires. Non-critical (no data loss), but a stuck spinner is possible.
- **Fix**: In the catch, post `listCached()` (if present) as a best-effort fallback, mirroring the overlay path.
- **Status**: accepted → **fixed** | **Triage**: Accepted. The native-success `refresh` catch now posts `listCached()` (seq-guarded) as a best-effort fallback so the panel isn't left spinning (TerminalViewProvider.ts).

### [S3] Synchronous `DatabaseSync` + `busy_timeout=5000` can block the extension-host event loop
- **Severity**: SUGGEST | **Confidence**: MEDIUM | **Priority**: P4 | **Agent**: chair
- **File**: `src/vault/sqlite.ts` (`defaultRunNodeWrite`)
- **Evidence**: `defaultRunNodeWrite` uses the synchronous `node:sqlite` `DatabaseSync` with `PRAGMA busy_timeout = 5000`. Under WAL write-lock contention, `.prepare(sql).run()` busy-waits synchronously on the main thread for up to 5s, freezing the extension host UI.
- **Impact**: Low probability — rename is a manual, one-at-a-time action and agents hold the WAL write lock only momentarily; hitting anywhere near 5s is unlikely. Still a hard main-thread block on the pathological path.
- **Fix**: Consider a shorter `busy_timeout` for the write (e.g. 500–1000ms) since a failed write degrades cleanly to the overlay, or document the accepted worst-case block.
- **Status**: accepted → **fixed** | **Triage**: Accepted. Reduced write `busy_timeout` 5000→2000ms (`WRITE_BUSY_TIMEOUT_MS`) with a comment documenting the bounded worst-case block + clean overlay degradation (sqlite.ts).

## Acknowledged / not reported (documented decisions)
- **Clearing a name on a SQLite agent leaves the native store title in place** (logic raised it): explicitly out-of-scope in `proposal.md` ("Reverting a previously native-written title on clear … clear removes the overlay only") and `design.md` D3 ("A previously native-written title stays — documented limitation"). Respected as a deliberate decision; not counted as a finding.
- **Codex `session_index.jsonl` stays stale after a DB-only write**: documented accepted limitation (design Risk Map).

## Verification questions — resolved
- **Q1 (fresh read reflects the write)**: Yes in practice. `force` guarantees `readAll` is invoked after the write; the incremental readers re-query only on a `sameStamps` mismatch, and a WAL `UPDATE` grows `-wal` (size+mtime) so the mismatch holds and the new title surfaces. Residual FS-resolution edge (identical mtime+size) is negligible for an append — not a guaranteed break. `force` delegates the re-query guarantee to the stamp.
- **Q2 (injection/scoping)**: Injection-safe — static SQL, `name`+`id` bound positionally; id regex-guarded before the write. Codex scoped `AND archived = 0`; OpenCode unscoped beyond `id` → W2.
- **Q3 (failure → overlay fallback, never throws)**: All non-`ok` statuses (`no-sqlite3`/`no-db`/`not-found`/`write-error`) map to `false`; `DatabaseSync` errors caught as `write-error`; handler try/catch guards a throw → overlay. Confirmed.
- **Perf**: No growth axis; single-row `UPDATE` by PK; force re-read is a fixed ≤2× incremental read bounded by `LIMIT 500` × 3 fixed stores (2 short-circuit on unchanged stamps). Suppressed.

## Sub-agents spawned
- data-security: **completed** — 1 WARN (W2)
- logic: **completed** — 1 WARN (W1) + 2 SUGGEST (S2; L2 excluded as documented)
- contracts: **completed** — 1 SUGGEST (S1)
- performance: **completed** — no findings (suppressed, bounded)
- frontend: not-spawned (no frontend files)
- chair self-review: 1 SUGGEST (S3)
