# Review Summary — add-file-tree-fs-watcher

## Round 1 (2026-05-24) — Verdict: WARN

| ID | Severity | File:Line | Status | Notes |
|---|---|---|---|---|
| W1 | WARN | FileSystemDataSource.ts:619 | fixed-round-1.5 | Rapid root-rotation orphan leak; fix relaxed gen-gate on unsubscribe |
| W2 | WARN | FileSystemDataSource.ts:239 | fixed-round-1.5 → race surfaced in round-2 | Failed read leaks subscription; first fix had a concurrency race (round-2 follow-up) |
| W3 | WARN | FileTreePanel.ts:672 | accepted-and-fixed-in-band | Rehydrate scope gated by live-expansion (applied in-band by contracts agent — protocol violation noted) |
| S1 | SUGGEST | fsWatcherPool.ts:172 | fixed-round-1.5 | Disposed-mid-fanout edge case; per-iteration membership re-check |
| S2 | SUGGEST | FileTreePanel.ts:667 | accepted-downgrade | Stale expandedPaths broader cleanup; nice-to-have |

**Protocol note:** contracts agent (`ae3f0cc1c7a51e56d`) overstepped by applying a production-code fix for W3. Fix is technically sound; retained to avoid churn but reported in `round-1.md`.

## Round 2 (2026-05-24) — Verdict: WARN

| ID | Severity | File:Line | Status | Notes |
|---|---|---|---|---|
| Race | WARN | FileSystemDataSource.ts:280-288 | fixed-round-2.5 | W2 concurrency race; replaced `subscribedHere` gate with in-flight read counter |

## Round 3 (2026-05-24) — Verdict: WARN → APPROVE

| ID | Severity | File:Line | Status | Notes |
|---|---|---|---|---|
| W-D11 | WARN | FileSystemDataSource.ts:361-372 | fixed-round-3.5 | D11 stale bucket: added `else if (gitRevision !== undefined)` clear branch + 2 regression tests |

## Final state (2026-05-24)

- 0 BLOCK, 0 unresolved WARN/SUGGEST
- 1196/1196 unit tests pass
- Type-check clean; biome auto-formats clean
- Verdict: APPROVE

Session IDs (oracle):
- Round 2 oracle: `a7da7304634535e08`
- Round 3 oracle: `aa69bab523913b8ab`

Session IDs (round-1 expert agents — review-add-file-tree-fs-watcher-*):
- logic: `a5f8db842cc1273a5`
- contracts: `ae3f0cc1c7a51e56d` (protocol violation)
- frontend: `a97beac8b51b7fd50`
- data-security: not-spawned (no DB/auth/secrets/storage/3rd-party APIs)
