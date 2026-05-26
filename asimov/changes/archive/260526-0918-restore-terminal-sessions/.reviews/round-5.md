# Review Round 5 — restore-terminal-sessions

**Date**: 2026-05-26
**Reviewable lines**: ~5,117 (full uncommitted diff incl. round-4 fixes + new state-machine tests)
**Agents spawned**: data-security ✓, logic ✗ (524 × 2), contracts ✗ (524 × 2), frontend ✓, oracle ✓
**Test gate**: 1306/1306 pass, typecheck clean
**Prior rounds**: round-1 BLOCK, round-2 BLOCK, round-3 APPROVE (premature), round-4 REJECT

## Verdict: **BLOCK** 🛑

2 NEW BLOCK findings — both surfaced by oracle, both regressions INTRODUCED by the round-4 [B2] epoch-token fix. The pattern repeats: a narrowly-scoped fix introduces a same-shape bug in adjacent code that no per-method reviewer caught.

**Counts**: 2 BLOCK / 3 WARN / 2 SUGGEST (3 suppressed)

---

## Round-4 fixes status verification

| ID | Status in Round-5 | Verified by |
|---|---|---|
| R4.B1 (queued destroy resurrects) | VERIFIED-FIXED (sessionsPendingDestroy + dispose/cleanupSession branching) | data-sec + frontend + oracle |
| R4.B2 (flushPending race overwrites clear) | PARTIALLY-FIXED → re-opened as R5.B1 (epoch unlink deletes newer file) | oracle |
| R4.B3 (onExit destroys exited snapshot) | VERIFIED-FIXED (flushSessionImmediateSync + cleanupSession releaseMirror branch) | data-sec |
| R4.B4 (purge async ordering) | VERIFIED-FIXED for the rmSync ordering. Partial regression in R5.W2 (sequential Memento awaits). | data-sec + oracle |
| R4.W1 (editor onReady sync) | VERIFIED-FIXED (now async + safeSendWithRetry + bail) | frontend |
| R4.W2 (panelSerializer UUID fallback) | PARTIALLY-FIXED → over-broad sweep regression (R5.W1) | frontend + oracle |
| R4.W3 (loadIndex unsupported-vs-missing) | VERIFIED-FIXED (loadIndexDetailed + hydrate gate) | (chair-verified) |
| R4.W4 (deferOpen no isSplitPane) | VERIFIED-FIXED (RestoreFromSnapshotMessage.isSplitPane + threading) | frontend |

**6/8 cleanly fixed. 2 partial. The 2 partials produced this round's 2 BLOCK findings (R5.B1 = R4.B2 redux; R5.W1 = R4.W2 redux).**

---

## Findings

### [B1] Stale-epoch unlink can DELETE the just-written valid snapshot file
**File**: `src/session/SnapshotPersistence.ts:591-624` + `:529-548` + `:683-707` + `src/session/SessionManager.ts:439-449` | **Agent**: oracle | **Confidence**: HIGH | **Priority**: P1

**Evidence**: The round-4 [B2] fix unlinks the canonical buffer file on epoch mismatch (`storage.unlinkBufferFile(id)` at L621-624). But the SYNC writers — `flushSessionImmediateSync` (L538), `flushSnapshotsSync` (L683/707), `writeBufferFileSync` from `purgePersistedSnapshot` path — write to the SAME canonical path `<sessionId>.snapshot.ans`.

Adversarial sequence (real D13 violation, traced by chair):
1. Async `flushPending` for session A starts. Captures `epoch_A = E`. Calls `writeBufferFileAsync(A, pre-exit content)` — in flight.
2. Natural shell exit fires `pty.onExit(0)` → `onShellExited` → `flushSessionImmediateSync(A)`:
   - Bumps epoch to `E+1`. Writes SYNC `writeBufferFileSync(A, exit content)`. File now has exit content. Assigns `_snapshotIndex[A] = exit metadata`. Writes sidecar sync.
3. `cleanupSession(A)`: `sessionsPendingDestroy.has(A) === false` AND `session.shellExited === true` → `releaseMirror(A)` → bumps epoch to `E+2`.
4. Step 1's async `writeBufferFileAsync` completes — overwrites the canonical file with stale pre-exit content.
5. Step 1's `flushPending` post-write epoch check: captured `E`, current `E+2` → mismatch → `storage.unlinkBufferFile(A)` → **file deleted**.
6. End state: file gone, `_snapshotIndex[A]` has exit metadata pointing to a missing file.
7. Next activate hydrate: reads metadata, `readBufferFile(A)` returns null → drops entry. **User loses the D13 read-only exit restore.**

**Impact**: The round-4 [B3] D13-preservation fix is silently defeated by the round-4 [B2] epoch fix. Two BLOCK fixes from the same round actively cancel each other.

**Suggested fix**: Use temp-file + rename for the async write path so stale writers never touch the canonical file:
1. `writeBufferFileAsync` writes to `<id>.snapshot.ans.tmp.<rand>`.
2. After the write completes, `flushPending` does the epoch check.
3. If epoch matches: `rename(temp, canonical)` + assign `_snapshotIndex[id]`.
4. If epoch mismatch: `unlink(temp)` only — canonical file (which may have been written by a newer sync writer) is untouched.

Alternative: single-flight `_flushInFlight` lock + while-loop draining `_pendingSessions`. Stale writes can't start while a newer sync writer is mid-write. Simpler but reduces concurrency.

---

### [B2] Debounced async sidecar write can OVERWRITE the sync shutdown sidecar with stale data
**File**: `src/session/SessionStorage.ts:152-155, 220-237, 71-84` + `src/session/SnapshotPersistence.ts:696-707` | **Agent**: oracle | **Confidence**: HIGH | **Priority**: P1

**Evidence**: `scheduleIndexWrite` (L220-237) fires-and-forgets BOTH `void this.writeIndexFile(toWrite)` (line 233, writes sidecar async) AND `void this.workspaceState.update(...)` (line 236, writes Memento). The async `writeIndexFile` writes the canonical sidecar path `<storageUri>/snapshots/index.json` (L154).

`flushSnapshotsSync` (deactivate path) calls `writeIndexSync(kept)` synchronously to commit the authoritative shutdown index. But if a debounced `scheduleIndexWrite` was scheduled before deactivate and its inner `writeIndexFile` is in flight on the libuv thread pool when deactivate's `writeIndexSync` runs:
1. Sync `writeIndexSync` writes shutdown index to sidecar (authoritative).
2. Async `writeIndexFile` completes after — overwrites sidecar with whatever the debounce captured (could be older state mid-debounce).
3. Next activate `loadIndexDetailed` reads sidecar → gets STALE metadata → wrong sessions hydrated, wrong cwd, possibly orphaned entries.

`cancelPendingIndex` can stop the timer but CANNOT stop an already-fired-async `writeIndexFile` call.

**Impact**: The whole point of the sync sidecar (write to disk during deactivate to survive Memento cancellation) is undermined: even after deactivate writes the correct sidecar, a stale async write can land afterward. Spec violation of the cross-restart-restore durability contract.

**Suggested fix**: Apply the same temp + rename pattern to async sidecar writes:
1. `writeIndexFile` writes to `index.json.tmp.<rand>`, then `rename(tmp, index.json)`.
2. Track a `_sidecarGeneration` counter; `writeIndexSync` and `purge` increment it.
3. Async `writeIndexFile` captures the generation before the write; on completion, if generation advanced, unlink the tmp file instead of renaming.

Alternative (simpler): remove sidecar writes from `scheduleIndexWrite`. Reserve sidecar writes for synchronous boundaries only (`flushSnapshotsSync`, `flushSessionImmediateSync`, `purgePersistedSnapshot`). Memento debounce remains async; sidecar is only the shutdown-durability layer.

---

### [W1] `TerminalPanelSerializer` sweep over-broadly cancels unrelated pending editor destroys
**File**: `src/providers/TerminalPanelSerializer.ts:45-53` | **Agent**: frontend + oracle | **Confidence**: HIGH | **Priority**: P2

**Evidence**: The round-4 [W2] fix sweeps all `editor-*` pending destroys whose viewId has no live provider (`!TerminalEditorProvider.findByViewId(pendingId)`). But a legitimately user-closed editor panel during its 5s grace window ALSO has no live provider — by design. An unrelated missing-state revive cancels that user-closed panel's destroy timer; `destroyAllForView()` never fires for that panel, `unregisterEditorPanel()` never runs, and at next `dispose()`, the session is treated as non-destructive and preserved via `releaseMirror()`. User-closed editor terminal can RESURRECT on the next activate.

Also: in multi-tab state-loss scenarios (e.g., workspace state corruption affecting several editor panels at once), the sweep cancels ALL unowned `editor-*` destroys — zombie PTYs accumulate.

**Impact**: A user-closed editor terminal can come back after restart whenever ANOTHER editor panel happens to revive without its panelId state. Privacy/intent violation.

**Suggested fix**: Don't sweep. Per oracle's direct recommendation: when state is missing, log the warning + let the original destroy fire normally (kills the new revive's PTY, which is the original W2 degradation we accepted). Alternative: refuse-to-revive on missing state — close the panel programmatically.

---

### [W2] `SessionStorage.purge()` sequential awaits — Canceled first update blocks second
**File**: `src/session/SessionStorage.ts:305-306` | **Agent**: data-security | **Confidence**: HIGH | **Priority**: P3

**Evidence**: B4 fix correctly moved `rmSync` ahead of Memento updates. But the two Memento updates at L305-306 are still sequential and unguarded:
```ts
await this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined);
await this.workspaceState.update(LIVE_EDITOR_PANELS_KEY, undefined);
```
If the first awaits throws Canceled (the same VS Code shutdown behavior B4 specifically addresses), the second never runs. `purge()` rejects, callers `void`-fire it → unhandled. Stale LIVE_EDITOR_PANELS Memento entry survives.

**Impact**: On next activate with `restoreEnabled=true` after toggle-off + quick quit, `hydrateLivePanels()` loads stale live-panels → editor panel revival tries to reuse panelIds whose snapshots were rm'd by B4's file cleanup → blank zombie editor panels. Self-healing (no buffer leak) but degrades the UX B4 protects.

**Suggested fix**: Wrap each Memento update in its own try/catch:
```ts
try { await this.workspaceState.update(SESSION_SNAPSHOTS_INDEX_KEY, undefined); } catch { /* fire-and-forget */ }
try { await this.workspaceState.update(LIVE_EDITOR_PANELS_KEY, undefined); } catch { /* fire-and-forget */ }
```
Or `Promise.allSettled([...])`.

---

### [W3] `destroyAllForView` race — session added between sync-enqueue and async-execute gets PTY killed but snapshot preserved
**File**: `src/session/SessionManager.ts:770-792` | **Agent**: data-security | **Confidence**: MEDIUM | **Priority**: P3

**Evidence**: `destroyAllForView` synchronously snapshots `viewSessionIds` and adds those ids to `sessionsPendingDestroy` (B1 fix). The queued `then(...)` re-reads `this.viewSessions.get(viewId)` at execution time and destroys whatever's there — which may include sessions added in the gap. New session N gets `performDestroy(N)` → `pty.kill()` → `cleanupSession(N)` → `sessionsPendingDestroy.has(N) === false` → `releaseMirror(N)` (preserves snapshot).

User's intent: "destroy all sessions in this view". Actual outcome for N: PTY killed but snapshot preserved → restores as live on next activate.

**Impact**: A session whose PTY was group-killed reappears next activate. Narrow window (session created + debounced flush completed + destroyAllForView already enqueued, all within ~1s), but inconsistent with user intent.

**Suggested fix**: Inside the queued `.then(...)` body, re-add every `id` to `sessionsPendingDestroy` before the destroy loop. Makes the destructive-intent set consistent with the actual destruction set.

---

## Suppressed (3 — track for follow-up)

| ID | Severity | File | Title | Why suppressed |
|---|---|---|---|---|
| D5.S1 | SUGGEST | SnapshotPersistence.ts:246 + SessionManager.ts:853 | `detachSession` during dispose uses debounced scheduleIndexWrite — never fires in shutdown | Self-healing via "missing file → drop entry" on next hydrate |
| F5.S1 | SUGGEST | TerminalEditorProvider.ts:592 (round-4 F3) | Concurrent user-message during async onReady | Verified benign — user-created session included in init.tabs |
| (chair) | SUGGEST | SnapshotPersistence.ts:339, 351 | Sync sidecar writes from purgePersistedSnapshot duplicates work | Cheap defensive belt-and-suspenders; harmless |

Plus: **logic + contracts agents timed out (CF 524 × 2 each)** — proceeding with 3 strong agents per skill workflow. Oracle's findings cover the cross-method coupling space that logic would normally catch.

---

## Architecture risk assessment (oracle, brutal)

> "This is no longer a sound boundary; it is a patch stack. SessionManager and SnapshotPersistence are sharing lifecycle intent through `sessionsPendingDestroy`, epochs, release/detach naming, sync flushes, and sidecar timing, but storage still has no transactional commit model and stale writers still target canonical paths."

Oracle's proposed redesign:
- **Per-session lifecycle state machine** owned by SessionManager: `live`, `pending-destroy`, `exited-preserved`, `disposing`, `purged`.
- **SnapshotPersistence accepts intentful commands**, not cleanup guesses.
- **Storage commits**: temp-file + generation + atomic rename for BOTH buffers and index.
- **Rule**: no stale async code path should ever unlink or overwrite the canonical artifact after a newer commit.

Chair's view: oracle is correct on the architecture, but the redesign is a 2-3 day change vs. ~1 day to apply temp+rename patches. Recommend patches now to unblock + accept "patch stack" tech debt explicitly, then schedule the redesign as a separate change.

---

## Round-5 process observation

This round confirms round-4's lesson: **same-shape bugs recur in adjacent code when fixes are narrowly scoped.** Round-4 fixed `detachSession unlinks newer file` (the original critical bug) and introduced `epoch unlink unlinks newer file` (R5.B1) — STRUCTURALLY identical, different surface. Same for B4 → R5.W2 (Memento canceled blocks file cleanup → Memento canceled blocks SECOND memento update). Each individual fix is locally correct; the SHAPE persists because the architecture invites it.

State-machine tests in `SessionManager.shutdownLifecycle.test.ts` would have caught R5.B1 had they been written to encode "natural exit during in-flight async flush" — they encoded `clearScrollback during in-flight` instead. Add the exit-mid-flush scenario.

---

## Test + Type Gate
- Type check: clean (`pnpm run check-types`)
- Tests: **1306/1306 pass** (7 new round-4-fix tests: B1×2, B2, B3×2, B4×2)
- Biome lint: not re-run (still OOMs per round-3 environmental note)

---

## Session IDs (round-5)

- data-security: `a5cc4e4421175c546` (succeeded round-5)
- logic: TIMED OUT (524 × 2) — fresh spawn would be `a13d17710080dfdb1` / `aa498795126ebe37d`
- contracts: TIMED OUT (524 × 2) — fresh spawn would be `a99f31e0817c88a67` / `ab891485fa2b9e31b`
- frontend: `aafaa73e80223d4f1`
- oracle: `a4786a977f9d13571`

## Persisted

- `asimov/changes/restore-terminal-sessions/.reviews/round-5.md` (this file)
- `asimov/changes/restore-terminal-sessions/.reviews/summary.md` (to be updated)
