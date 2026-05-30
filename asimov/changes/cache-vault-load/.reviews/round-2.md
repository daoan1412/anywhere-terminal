# Code Review — round 2 (cache-vault-load, post-merge on `main`)

Date: 2026-05-30. Chair: asm-review (this session).
Reviewers: asm-review-data-security, asm-review-logic, asm-review-frontend, asm-oracle.
Diff reviewed: `git diff 6387624..c3ba5f3` — the cache feature as integrated on `main` (the
merge commit `c3ba5f3`, which combined cache-vault-load `7ea426b` with the nest-workflow main
tip `6387624`). 12 reviewable source files (~650 lines), 8 test files; 9 `.md` artifacts skipped.

Human focus for this round: "is the code actually good, fail-safe, and does it run on Windows?"
→ oracle spawned in addition to the three specialists, weighted to Windows + fail-safe.

Verification at review time: `tsc` clean; `test:unit` 1869/1869; Biome clean on changed files.

## VERDICT: WARN → all accepted findings FIXED (re-verified)

No BLOCK. Four should-fix items (3 of them flagged HIGH by ≥1 reviewer, with convergence
between logic + oracle on the top one) were accepted and fixed; two MEDIUM items were
consciously DEFERRED with rationale. Re-verified after fixes: `tsc` clean, Biome clean,
**`test:unit` 1881/1881** (1869 + 12 new tests), 3× full-suite stable.

## Findings + disposition

| # | Severity | Source(s) | Finding | Disposition |
|---|---|---|---|---|
| F1 | WARN (HIGH) P1 | logic + oracle | Transient whole-reader failure dropped that agent's entries AND omitted its cache, then `refresh()` persisted the partial doc — wiping the agent's sessions from the list and the saved snapshot until the next successful read. Webview also doesn't surface `unreadable`, so the disappearance is silent. | **ACCEPTED + FIXED.** `VaultService.readAll` now, on reader rejection, carries forward the prior per-agent freshness cache AND the agent's prior entries (last-known-good), and labels the reason `…: reader failed — showing last cached`. Self-corrects on the next successful read. Nothing prior (first run) → agent simply absent. Tests added (preserve-on-2nd-refresh; first-run-no-carry). |
| F2 | WARN (HIGH) P3 | oracle + data-security | `load()` validated only top-level `entries`/`unreadable`; the `agents` freshness blob was accepted as any object. A corrupt `{kind:"store", sources:null}` would reach a reader as `prev` and throw in `sameStamps`→`Object.keys(null)`, failing the reader — which (via F1) dropped the agent. | **ACCEPTED + FIXED.** `VaultCacheStore.load` now deep-validates each `agents[id]` against the `ReaderListCache` union (`files`: finite stamps + valid entries; `store`: finite `sources` stamps + valid entries + finite `unreadable`; unknown discriminant rejected). Any failure voids the whole cache → full rebuild. 6 tests added. |
| F4 | WARN (HIGH) P2 | frontend | The latest-wins token was checked ONCE before `safeSendWithRetry`, but the retry sleeps 50 ms between attempts. A newer `requestVaultSessions` arriving during that window let the stale request's retry post an older list AFTER the newer one — a visible flash-back to old data. | **ACCEPTED + FIXED.** `safeSendWithRetry` gained an optional `shouldAbort` predicate checked before EVERY attempt (incl. before each retry); the vault fresh response passes `() => token !== this._vaultRefreshSeq`. Backward-compatible (param defaults to no-abort). Deterministic provider test added. |
| F-Win | WARN (HIGH) P2 | oracle | (a) `mode: 0o600/0o700` is POSIX-only — Node ignores it on Windows (NTFS ACLs), so the design.md-D5 privacy claim overstated the at-rest boundary on Windows. (b) `fs.rename` over an existing destination can throw transient `EPERM`/`EBUSY`/`EACCES` on Windows when another window/AV/indexer holds the file; the single attempt degraded silently and left a sensitive temp behind until next activate. | **ACCEPTED + FIXED.** (a) Comments in `VaultCacheStore.ts` + design.md D5 corrected to state POSIX-only; on Windows the file inherits `globalStorageUri` profile ACLs (same as `SessionStorage`). (b) `save()` now renames via `renameWithRetry` (3 attempts, 20·n ms backoff, only on EPERM/EBUSY/EACCES) and unlinks the temp on final failure before rethrowing (caught+logged by `refresh`, never crashes). 3 tests added. |
| F3 | SUGGEST (MED) | logic + oracle | `(mtimeMs,size)` freshness can miss a same-size in-place rewrite on coarse-resolution filesystems (FAT/exFAT ~2 s); a changed source could be served stale until another write changes size/mtime. | **DEFERRED (documented).** Real-world exposure is low: NTFS (default Windows) is 100 ns; the dominant stores (`~/.claude/*.jsonl`, SQLite `.db`+`-wal`) are append-mostly so size changes catch edits; the cache is non-authoritative and self-heals on the next size/mtime change. The robust fix (bigint `mtimeNs` + cache schema v2 bump) is disproportionate for this round. Recorded for a future hardening pass. |
| F5 | SUGGEST (MED) P3 | logic | Single-flight ordering is per-`VaultService`-instance only. Two VS Code windows sharing `globalStorageUri`: a window running a slower refresh from an older snapshot can `save()` after a window that already saved a newer doc, regressing the persisted instant-render cache by one cycle. | **DEFERRED (accepted limitation).** Cache is non-authoritative — actions re-resolve by id through the uncached source-of-truth read; rename stays atomic so no corruption; the worst case is a one-cycle-stale instant render that self-heals on either window's next refresh. A correct cross-process guard (read-modify-write on `savedAt`, or an advisory lock) adds TOCTOU-prone coordination for marginal benefit. Recorded. |

## Data-security residual (no fix needed)

- `cleanupOrphanTemps()` could unlink another window's in-flight temp before its rename (data-security
  SUGGEST P5) — fail-safe (the victim's `save()` rejection is caught + logged; rename is atomic; self-heals).
  Partly mitigated now: `save()`'s own final-failure path unlinks its temp. Left as-is.
- Confirmed safe by the reviewers: poisoned `sessionPath`/`cwd` in the cache never drives a host file op
  (every action re-resolves by id through the UNCACHED `list()`/`getEntry()`); webview writes untrusted
  strings via `textContent` only; no titles/cwds/paths logged on the persist/error paths; `-shm` correctly
  excluded from SQLite stamping.

## Windows verdict (the human's priority question)

Runs on Windows. After the fixes: the privacy claim is now honest (POSIX-only; Windows = inherited
profile ACLs), atomic-write transient lock failures are retried and self-cleaning, paths use `path.join`
(no hardcoded separators), `process.pid` temp naming is fine, `-wal`/`-shm` semantics are correct.
The one residual Windows caveat is F3 (coarse-FS mtime) — not a concern on NTFS, deferred.

## Files changed by the fixes

- `src/vault/VaultService.ts` — F1 (preserve last-known-good on reader rejection).
- `src/vault/VaultCacheStore.ts` — F2 (validate `agents` union), F-Win (renameWithRetry + temp cleanup, claim wording).
- `src/providers/TerminalViewProvider.ts` — F4 (`shouldAbort` in `safeSendWithRetry`; vault fresh send passes the token check).
- `asimov/changes/cache-vault-load/design.md` — F-Win (D5 POSIX-only correction).
- Tests: `VaultService.test.ts` (+2), `VaultCacheStore.test.ts` (+9), `TerminalViewProvider.test.ts` (+1).

## Final state

`tsc` clean · Biome clean · `test:unit` 1881/1881 · 3× full-suite stable.
No open BLOCK/WARN. F3 + F5 deferred with rationale (non-authoritative, self-healing; heavy fixes out of scope).

## Session IDs (re-review continuity)

- data-security: review-cache-vault-load-data-security (`aa4f0461e4d72f345`)
- logic: review-cache-vault-load-logic (`a8184979931a49b0c`)
- frontend: review-cache-vault-load-frontend (`a96070cfab21485cc`)
- oracle: review-cache-vault-load-oracle (`ac3fe63b3bc13a77f`)
