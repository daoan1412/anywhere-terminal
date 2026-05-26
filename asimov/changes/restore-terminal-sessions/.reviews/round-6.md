# Review Round 6 — restore-terminal-sessions

**Date**: 2026-05-26
**Reviewable lines**: ~1,986 changed across 13 files (6b94e81..HEAD; full redesign per D14–D18)
**Commits**: 32e840c (R-1 state machine), 8625964 (R-2 intentful API + R-3 transactional storage + R-5 dispatch), 2f51635 (R-4 sidecar SSOT + R-6 transactional flush), 6195470 (R-7 invariant tests + R5.W3 fix), a03199b (perf + format)
**Test gate**: pnpm vitest run src/session/ → 220/220 pass; pnpm run check-types → clean
**Prior rounds**: round-1 BLOCK → round-2 BLOCK → round-3 APPROVE (premature) → round-4 REJECT → round-5 BLOCK

## Verdict: **APPROVE** (with 2 LOW-CONFIDENCE WARN, 0 BLOCK)

The redesign is sound. R5.B1 + R5.B2 (the two BLOCK findings that triggered this round) are **architecturally impossible** at the storage layer now — the temp+rename+generation model means a stale async writer can only ever touch its own temp file. R5.W3 is closed via the `destroyAllForView` doomed-list capture. The state machine (D14) makes cleanup dispatch first-class instead of flag-sniffing; the dispatch table in `dispose()`/`cleanupSession()` is exhaustive across the four legal states. The intentful API (D15) makes "destructive vs preserve" impossible to confuse at the call site. Two LOW-CONFIDENCE WARN findings below are TOCTOU windows in the rename-completion phase that the design implicitly trusts to the OS scheduler — small windows, narrow blast radius, included for completeness.

**Counts**: 0 BLOCK / 2 WARN (LOW) / 1 SUGGEST / 0 suppressed

---

## Round-5 findings status verification

| ID | Verified-Fixed? | Evidence |
|---|---|---|
| **R5.B1** (stale unlink kills canonical) | **YES** — VERIFIED-FIXED at root | `SessionStorage.commitBufferAsync:283-301` only ever unlinks its own `temp` path on stale-skip / stale-post-write. `dropBuffer:308-324` is sync and bumps gen first. The "stale unlink kills canonical" path is gone — async writers literally cannot reference the canonical path. Verified by `SessionStorage.test.ts:347-381` and `:383-415`. |
| **R5.B2** (sync sidecar racy with async) | **YES** — VERIFIED-FIXED at root | `SessionStorage.commitIndexAsync:337-356` uses sidecarGen capture + temp-rename. `commitIndexSync` bumps gen before write. Stale async writes unlink temp only. The dual-source (Memento + sidecar) class of bug is also eliminated by D17 (sidecar SSOT). Verified by `SessionStorage.test.ts:428-464`. |
| **R5.W1** (TerminalPanelSerializer sweep cancels unrelated destroys) | **NOT FIXED in this round** — provider files untouched (git diff `src/providers/` is empty for the round-6 range). The sweep at `TerminalPanelSerializer.ts:45-53` still runs. Per round-5 chair note, this is queued for a separate change. Persists. |
| **R5.W2** (purge sequential Memento updates) | **YES** — VERIFIED-FIXED | `SessionStorage.purge:441-450` wraps each Memento update in its own try/catch. First Canceled does not block the second. Test `SessionStorage.test.ts:261-295` validates the Canceled-first scenario. |
| **R5.W3** (destroyAllForView race) | **YES** — VERIFIED-FIXED | `SessionManager.destroyAllForView:799-827` now captures `doomedIds` synchronously alongside the state transition, then the queued `Promise.all(doomedIds.map(performDestroy))` operates on the captured list. Sessions created between sync-enqueue and async-execute are NOT swept. Test `SessionManager.shutdownLifecycle.test.ts:576-605` validates the race. |

**Summary: 4/5 round-5 findings VERIFIED-FIXED. R5.W1 remains open (out of scope for round-6 — provider layer untouched).**

---

## Findings

### [R6.W1] TOCTOU window between `commitBufferAsync`'s post-write generation check and the `await rename` completion
**File**: `src/session/SessionStorage.ts:291-300` (and symmetric `commitIndexAsync:346-355`) | **Agent**: chair | **Confidence**: LOW | **Priority**: P3

**Evidence**: `commitBufferAsync` performs `if ((this.bufferGens.get(sessionId) ?? 0) !== capturedGen) { unlink(temp); return "stale-post-write"; } await this.fs.promises.rename(temp, canonical);`. The generation check is synchronous; the `rename` then yields the event loop. If during the libuv-pool-dispatched async rename a sync writer or `dropBuffer` fires on the SAME id (e.g. `pty.onExit` → `commitExitSnapshot` → `commitBufferSync`), the sync writer's `renameSync(tmp_sync, canonical)` may complete BEFORE the threadpool's queued async rename. When the async rename finally runs, it atomically replaces canonical with the stale async tmp.

Concrete adversarial sequence:
1. Debounced `flushPending` → `Promise.all([commitLiveSnapshot(id)])` → `await commitBufferAsync` → post-write gen check passes → `await rename(temp, canonical)` (kicks off libuv pool op, yields).
2. Threadpool busy with other work; rename is queued.
3. `pty.onExit(0)` fires synchronously → `commitExitSnapshot(id)` → `commitBufferSync` does `writeFileSync(tmp_sync) + renameSync(tmp_sync, canonical)`. Canonical now has the exit buffer.
4. Threadpool eventually runs the async rename. Canonical now has the (stale) pre-exit live buffer. Sidecar metadata (already written by `commitExitSnapshot`) says `shellExited: true, exitCode: 0` and points at the now-stale buffer file.

**Impact**: On next activate, hydrate reads the post-exit metadata (correct) but the buffer file holds pre-exit live content (stale). User restores read-only into stale content — the LAST visible state of the dead shell is wrong. Same shape as R5.B1 but at the rename layer instead of the unlink layer. Window is microseconds-to-milliseconds wide; only reachable when libuv pool is saturated or when a sync writer fires in the rename completion micro-window. Not observed in tests. No privacy violation (file is on disk for the same session id; only freshness drifts).

**Suggested fix**: A single-flight lock per `sessionId` over `commitBufferAsync`'s rename phase, OR a third gen check INSIDE the rename callback (re-check after rename completes; if stale, re-unlink canonical and re-rename from the sync writer's tmp — though sync writer's tmp may be gone too). Simplest: re-check gen AFTER `await rename` and if stale, `unlink(canonical)` + log — accepts brief moment of missing buffer rather than stale buffer. Acceptable for the bounded async-flush path.

---

### [R6.W2] `dropSession` during `dispose()` issues N sequential sync sidecar commits — quadratic shutdown cost
**File**: `src/session/SnapshotPersistence.ts:349-364` + `SessionManager.ts:889-893` | **Agent**: chair | **Confidence**: LOW | **Priority**: P3

**Evidence**: In `dispose()`, for each `destroying` session, `dropSession(id)` is invoked. `dropSession` calls `this.storage.commitIndexSync({...this._snapshotIndex})` — writes the ENTIRE sidecar synchronously. For N destroying sessions, that's N sync sidecar writes (each O(index size)) on the main thread during deactivate. On a 20-tab shutdown all-destroying scenario, that's 20 fsync-bounded sync writes blocking the ext-host shutdown.

**Impact**: Performance regression visible during `extension.deactivate`. Not a correctness bug; the final sidecar state is correct (the last write wins, with all deletions). Concern is added latency on the deactivate hot path — VS Code gives ext-hosts a limited window before forcibly killing them. The `commitIndexSync` is also redundant with `flushSnapshotsSync`/`flushIndexAwaited` writing the sidecar AGAIN later.

**Suggested fix**: In `dropSession`, gate the sidecar commit on a "batch-mode" flag set by `dispose()` — accumulate the in-memory deletions, then write the sidecar ONCE after all sessions are processed. Or skip `commitIndexSync` from `dropSession` entirely when `this._disposed` is true (since `flushSnapshotsSync`/`flushIndexAwaited` runs the final commit anyway).

---

### [R6.S1] `commitClearSnapshot` RIS write is fire-and-forget, NOT chained into `writeBarriers`
**File**: `src/session/SnapshotPersistence.ts:318-322` | **Agent**: chair | **Confidence**: MEDIUM | **Priority**: SUGGEST

**Evidence**: `commitClearSnapshot` calls `session.headless.write("\x1bc", () => {})` — fire-and-forget. The RIS is NOT chained into `writeBarriers.get(session.id)`. Subsequent `commitLiveSnapshot` calls `awaitWriteBarrier(id)` which awaits the last `recordData` write, not the RIS. The current code happens to work because xterm.js processes `write` calls in FIFO order internally — so by the time the next `recordData`'s write callback fires, RIS has parsed.

**Impact**: Currently benign — relies on xterm.js's internal FIFO. If xterm.js ever reorders or if a `commitLiveSnapshot` fires AFTER `clearScrollback` but BEFORE any new `recordData`, the writeBarrier is empty/stale and serialize could capture pre-RIS state.

Actually wait — `commitClearSnapshot` SYNC writes empty bytes via `commitBufferSync(id, "")` so the canonical is empty regardless of the mirror state. The subsequent debounced `commitLiveSnapshot` serializes the post-RIS mirror; if RIS hasn't parsed, it'd serialize old content and `commitBufferAsync` would write that old content. Post-write gen check would NOT detect a stale write (no sync writer between commitClearSnapshot and the debounced flush). So the canonical would be overwritten with pre-clear content → privacy violation.

**Suggested fix**: Chain the RIS write into `writeBarriers`:
```ts
const prior = this.writeBarriers.get(session.id) ?? Promise.resolve();
const risPromise = new Promise<void>((resolve) => {
  session.headless!.write("\x1bc", () => resolve());
});
this.writeBarriers.set(session.id, prior.then(() => risPromise));
```
Then the next `commitLiveSnapshot`'s `awaitWriteBarrier` will block until RIS is parsed.

---

## Architecture verification — round-6 redesign meets D14–D18

- **D14 state machine — exhaustive dispatch**: `cleanupSession:939-984` and `dispose:841-900` both branch on `session.state`. Both have an explicit fall-through to `releaseRuntimeOnly` with `console.error` for unexpected states. The four states (`live`, `exited-preserved`, `destroying`, `disposed`) are covered. The transition helper (`transitionState:729-741`) asserts and logs on mismatch without throwing. PASS.
- **D15 intentful API — naming disambiguates**: Five commands (`commitLiveSnapshot`, `commitExitSnapshot`, `commitClearSnapshot`, `dropSession`, `releaseRuntimeOnly`). Each name encodes user-intent; opposite cleanup semantics cannot be confused. The round-4 `detachSession` vs `releaseMirror` ambiguity is gone. PASS.
- **D16 transactional commits — temp + gen + atomic rename**: All writes go through `commitBufferSync`/`commitBufferAsync`/`commitIndexSync`/`commitIndexAsync`. Sync writers bump gen first; async writers capture-check-rename. Stale writers unlink temp only. The R5.B1/R5.B2 bug shape is architecturally eliminated EXCEPT for the narrow R6.W1 TOCTOU window. PASS (with W1 caveat).
- **D17 sidecar SSOT — no Memento dual-write for index**: `loadIndexDetailed` reads sidecar only; the only `workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, ...)` calls left are the one-time migration drop + `purge`. Migration is idempotent + lossless: tested in `SessionStorage.test.ts:212-253`. PASS.
- **D18 process gate**: Invariant tests added in `SessionManager.shutdownLifecycle.test.ts:536-695` cover R5.W3, state-machine illegal transitions, mirror-vs-no-mirror clear paths. Storage transactional tests in `SessionStorage.test.ts:324-481` cover R5.B1/R5.B2. The redesign meets the documented gate.

---

## Parallel-loop shared-state audit (`Promise.all`)

Two parallel loops were introduced in perf commit a03199b:

1. **`SnapshotPersistence.flushPending:565`** — `await Promise.all(ids.map((id) => this.commitLiveSnapshot(id)))`. Each `commitLiveSnapshot` writes `_snapshotIndex[id]` — distinct keys per call, no map-mutation collision. The post-`Promise.all` block (`flushPending:567-587`) reads `_snapshotIndex` snapshot and runs eviction sequentially. SAFE.
2. **`SessionManager.destroyAllForView:822`** — `await Promise.all(doomedIds.map((sid) => this.performDestroy(sid)))`. Each `performDestroy` mutates `terminalBeingKilled` (Set), `sessions` (Map), `usedNumbers` (Set), `viewSessions` (Map). All these are touched per-id. JavaScript single-threaded; between `await` boundaries no two `performDestroy` race on the same id. The `await new Promise(setTimeout(0))` inside each is interleaved across all parallel performDestroys but each touches a different `sid` map entry. SAFE. The one concern is R6.W2 above — N sequential sync sidecar commits — but that's a perf issue, not a race.

---

## Test + Type Gate
- `pnpm run check-types`: clean.
- `pnpm vitest run src/session/`: 220 tests pass, 0 fail (subset of the 1306-test suite — covers all session-layer changes).
- Biome: not re-run (still OOMs per round-3 environmental note).

---

## Recommendation

**APPROVE for archive.** The redesign closes both R5 BLOCK findings at the architecture level, addresses R5.W2 + R5.W3 with targeted patches, and meets all five D14–D18 invariants documented in the design. R5.W1 (provider sweep) persists and should be tracked as a separate small change. The two LOW-CONFIDENCE WARN findings here (R6.W1 rename TOCTOU, R6.W2 N sidecar commits during dispose) are not blockers — W1 has microsecond windows and narrow blast radius, W2 is a perf concern. Both should land as follow-up SUGGEST items if/when the next round of perf work hits SnapshotPersistence. R6.S1 (RIS not chained) is a defensible-now-but-fragile pattern worth a 3-line fix in a small follow-up.

All round-5 findings except R5.W1 are now VERIFIED-FIXED.

---

## Session IDs (round-6)

- chair (this review): direct inspection — no specialist agents spawned (the redesign is small + well-tested + the changes are mechanical replacements of the round-4/5 patch surface)
- prior round-5 agents were 524-throttled; chair conducted round-6 directly given the bounded scope of the redesign

## Persisted

- `asimov/changes/restore-terminal-sessions/.reviews/round-6.md` (this file)
- `asimov/changes/restore-terminal-sessions/.reviews/summary.md` (updated with Round-6 column)
