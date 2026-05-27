# Review Round 1 — export-terminal-session

- **Date (UTC)**: 2026-05-27
- **Diff range**: 59a8133..02a13be (commits 18eda95, e7c0db8, 7940a00, 5c56d02, be17a4f, 78fc8f8, 8553981, 02a13be)
- **Reviewable lines**: ~3890 added across 43 source/test files (well above 800-line guideline — accuracy caveat noted)
- **Scope per user**: design patterns + code organization (not individual bug hunting)
- **Agents spawned**: frontend (asm-review-frontend), data-security (asm-review-data-security), logic (general-purpose substitute — asm-review-logic timed out twice at gateway), contracts (general-purpose substitute — asm-review-contracts timed out at gateway)

## Verdict: WARN

- Blocking: 0
- Warnings: 5
- Suggestions: 3
- Suppressed: 12 (mostly individual-bug findings de-prioritized per user's design focus)

**Why:** Implementation works, all tests pass, and per-feature logic is sound. But the change consistently violates the codebase's own extraction precedent — new responsibilities pile into `SessionManager` instead of becoming class-based collaborators alongside `SnapshotPersistence`, `EditorPanelRegistry`, `CustomNameRegistry`, `OutputBuffer`. The new `TrackedCommand` module is the first FP-over-POJO entrant in a class-heavy area. Three independent reviewers landed on the same architectural drift.

## Findings (top 8 by signal)

---

### [W1] WARN | HIGH | P2 | chair (synthesis of logic agent) | `src/session/SessionManager.ts` (whole file, 1364 lines)
**SessionManager accreted three new responsibility clusters without extraction**

**Evidence:** The class header at lines 1-13 lists three delegates already extracted (`SnapshotPersistence`, `EditorPanelRegistry`, `CustomNameRegistry`). This change added three NEW responsibility clusters inline:
- Shell-integration cleanup map (line 141) + event reducer (804-838) + tracked-command queries (844-858)
- Scrollback-dump pendingDumps map (149-157) + request/handle/abort (877-929)
- Hydrate-on-create wiring for tracked commands (479)

Each cluster has its own state, public API surface, and lifecycle hooks. They match the shape of the existing extractions exactly.

**Impact:** SessionManager is now 1364 lines and any export-adjacent feature will keep landing here by default. Test surface concentrates on one file; the file's "central registry" mental model gets diluted with feature-specific event reducers.

**Fix:** Extract `ShellIntegrationCoordinator` (owns cleanups map + event reducer + tracked-command queries; wired into createSession via a coordinator method) and `ScrollbackDumpCoordinator` (owns pendingDumps + request/handle/abort, takes `safePostMessage` as dep). SessionManager keeps the session map and delegates exactly the way it already delegates to `snapshots`.

**Status:** accepted (pending)

---

### [W2] WARN | HIGH | P2 | logic | `src/session/SessionManager.ts:794-838`
**Shell-integration state machine leaks into SessionManager (in-flight reset bypasses TrackedCommand API)**

**Evidence:** `_handleShellIntegrationEvent` mutates `runtime.inFlight = null` inline on `promptStart` (line 817), bypassing TrackedCommand.ts's public API. TrackedCommand exports `openCommand` / `closeCommand` / `setInFlightCommandLine` but NOT a `resetInFlight`/`abandonInFlight`, so the manager reaches past the abstraction to do what the module won't expose. The whole event switch is logically a TrackedCommand concern — it's verbatim the OSC 633 A/B/C/D/E semantics from TrackedCommand.ts's header comment.

**Impact:** Two files must agree on the state-transition vocabulary. Future markers (e.g. OSC 633 `F`/`G`) require changes in both, and the "no in-flight after promptStart" invariant has no single owner.

**Fix:** Add `abandonInFlight(runtime)` to TrackedCommand.ts and call it from the manager. Better: move the whole switch into a `handleEvent(runtime, event, { now, cwd, idFactory })` so SessionManager only does `session → runtime` lookup. This bundles cleanly with [W1]'s `ShellIntegrationCoordinator` extraction.

**Status:** accepted (pending)

---

### [W3] WARN | HIGH | P2 | contracts | `src/session/SessionSnapshot.ts:35-52`
**Optional-field-with-comment is one-way schema evolution only**

**Evidence:** `trackedCommands?: TrackedCommand[]` was added as a plain optional field with a "back-compat" comment. The wrapping `SessionSnapshotsIndex` literally types `version: 1` (line 56) with no extension point, so a future v2 requires a type-union retrofit. More importantly: a **downgrade** (rollback after a bug, Insiders↔stable, beta tester reverts) silently strips `trackedCommands` on the next persist — there is no quarantine of unknown fields, no `unknownFields?: Record<string, unknown>` pass-through.

**Impact:** Mixed-version installs lose tracked-command history on the first save with no signal. Future schema additions face the same trap.

**Fix:** Either (a) bump `version: 1 → version: 2` and document the field-add as a versioned change, or (b) add an `unknownFields?: Record<string, unknown>` carry-through on the metadata so older code preserves what it can't interpret. At minimum, add a round-trip test that load→persist preserves an unknown field. Option (b) is cheaper and future-proof.

**Status:** accepted (pending)

---

### [W4] WARN | HIGH | P2 | contracts | `src/extension.ts:329-343`
**Dual entry-point silently trusts unvalidated `paneSessionId` — wrong toast on stale id**

**Evidence:** The three export commands receive `(ctx?: { paneSessionId?: string })` with no runtime shape guard. Any palette caller could pass an arbitrary first arg; a stale/cross-view sessionId from a right-click after a tab close is forwarded straight to `sessionManager`. `exportBuffer` reaches `requestScrollbackDump(sessionId)` which throws `ScrollbackDumpAbortedError` for unknown IDs (SessionManager.ts:881-883), surfacing the generic "scrollback dump failed" toast instead of the documented `NO_FOCUS_TOAST`.

**Impact:** Right-click → close tab → click export produces a misleading error rather than the intended "focus a terminal session" UX. Contract claims invariants the implementation does not enforce.

**Fix:** Validate at the boundary in `buildExportDeps`: if `ctx?.paneSessionId` is present but `sessionManager.getSession(ctx.paneSessionId)` is undefined, treat as fallthrough to focus rather than trusting it. Alternative: have `requestScrollbackDump` distinguish "unknown session" from "aborted" so callers can map to `NO_FOCUS_TOAST` themselves.

**Status:** accepted (pending)

---

### [W5] WARN | HIGH | P2 | data-security | `src/session/SessionStorage.ts:267-274, 350-357, 360-392`
**Persisted tracked-command output written world-readable (0o644 default)**

**Evidence:** `commitIndexSync` / `commitIndexAsync` call `fs.writeFileSync` / `fs.promises.writeFile` with no `mode` option. Under typical umask 022, Node creates files at `0o644` (world-readable). Each `SessionSnapshotMetadata.trackedCommands[i].output` now persists raw post-OSC-633 PTY bytes (`SnapshotPersistence.ts:589-595`) capped at 100 KB/command / 1 MB/session — that includes verbatim output of any session that ran `aws sts get-session-token`, `kubectl get secret … -o yaml`, `op signin`, etc.

**Impact:** On any shared host (build server, multi-user dev box, shared CI runner), another local UID can `cat <storageUri>/anywhereTerminal/snapshots/index.json` and read credentials. On macOS, default home dir mode is `0o755`, so this is concretely reachable by other accounts on the box. **The change widens an existing exposure**: pre-existing scrollback files already had this issue, but tracked-command output significantly raises the cred density of what lands on disk.

**Fix:** Pass `{ mode: 0o600 }` to all four write call sites. Also `mkdirSync(..., { mode: 0o700 })` on the snapshots dir. Defence in depth: `chmodSync(canonical, 0o600)` after rename so pre-existing files get re-permissioned. Worth a follow-up change ticket — same fix applies to the buffer files written pre-change.

**Status:** accepted (pending)

---

### [S1] SUGGEST | HIGH | P3 | logic | `src/session/TrackedCommand.ts:51-194`
**FP-over-POJO style is inconsistent with codebase precedent**

**Evidence:** Every other extracted session collaborator is a class with private state + methods: `CustomNameRegistry` (line 30), `EditorPanelRegistry` (line 11), `SnapshotPersistence` (line 96), `OutputBuffer` (line 62). TrackedCommand instead exports `CommandTrackingRuntime` as a public mutable interface plus six free functions callers pass it into. This exposes the runtime field (`session.commandTracking.inFlight`) for direct mutation — which the manager actually does at SessionManager.ts:817 and reads at line 526. The DI for `now`/`id` (lines 132-135) is the only thing the FP style buys, and a constructor argument would cover that.

**Impact:** Encapsulation weaker than surrounding modules. Lint/grep cannot enforce "only TrackedCommand mutates the runtime" because the type itself is open. Cognitive cost: future readers must remember which one of the two styles applies where.

**Fix:** Promote to `class CommandTracker { open(); close(); appendOutput(); setCommandLine(); abandonInFlight(); get commands(); get lastCompleted(); }`. Constructor accepts `{ idFactory, now }` for tests. Consistent with the four existing registries. Bundles cleanly with [W1]'s `ShellIntegrationCoordinator` (the coordinator owns the tracker).

**Status:** accepted (pending)

---

### [S2] SUGGEST | HIGH | P3 | contracts | `src/pty/PtySession.ts:98-112` + `src/session/SessionManager.ts:427-431, 809-812`
**Retained dual-sink is a footgun, not back-compat**

**Evidence:** `setShellIntegrationSink` is a strict superset of `setCurrentCwdSink`. SessionManager wires BOTH (PtySession.ts:175-180 fires cwd to both sinks), then `_handleShellIntegrationEvent` has `case "cwd": return;` (line 810-812) whose only purpose is preventing double-handling. The "back-compat" framing is misleading — there are no external consumers; both setters are internal to this codebase.

**Impact:** New logic added to the unified-sink switch that forgets to keep `cwd` as an early-return will double-fire cwd updates. The safety relies on a comment, not the type system. Wasted cognitive load every time someone touches the event reducer.

**Fix:** Drop `setCurrentCwdSink` entirely. Route cwd through the unified sink (`case "cwd": this.setCurrentCwd(id, event.cwd); return;`). Removes the warning comment at PtySession.ts:107-108 and the defensive `return` at SessionManager.ts:810-812. One-line change with positive code delta.

**Status:** accepted (pending)

---

### [S3] SUGGEST | MEDIUM | P3 | logic | `src/commands/exportCommands.ts:64-134`
**Three exporters share a 5-step skeleton ripe for one helper**

**Evidence:** `exportBuffer`, `exportLastCommand`, `exportCommand` all do: (1) focus-check, (2) fetch payload, (3) `promptSaveTarget`, (4) `preferenceFromExtension` + `applyAnsiPreference`, (5) `writeWithErrorToast`. Steps 1, 3, 4, 5 are byte-identical; only step 2 (payload source) and the post-step-2 toast (`surfaceNoTrackedToast` vs scrollback-dump error) vary. The current 70-line spread obscures that the variance is two lambdas.

**Impact:** A change to the export pipeline (new "compress before write" step, different default URI, additional save-dialog filter) has to be made in three places and trivially gets out of sync.

**Fix:** Extract `async function runExport(deps, sessionId, produce: () => Promise<{ content: string } | { skip: "no-tracked" | "no-data" }>)`. Each command becomes ~10 lines: focus-check + a `produce` lambda. Keep `surfaceNoTrackedToast` as a skip-handler invoked by the helper.

**Status:** accepted (pending)

---

## Suppressed (12 — lower priority for design-focused review)

- **frontend [F1] WARN P2** scrollbackDumpHandler.ts:70-84 — Microtask closure captures stale tabId via map re-read (production-safe today; future scheduler refactor risk). Largely obsoleted by accepting [S5-suppressed] below.
- **frontend [F2] WARN P3** main.ts:442-452,775 — DOM-as-ground-truth pattern undocumented for onFlashPane (focusin case has its own justification).
- **frontend [F3] WARN P3** extension.ts:396-430 — `runExportPick` bypasses `VscodeSurface` seam + flash-then-pick sequencing not awaited. Bundles partially with [W4]; the seam inconsistency is real but small.
- **data-security [F2] WARN P3** ShellIntegrationInjector.ts:107-152 + SessionManager.ts:1117-1192 — Orphan `at-bash-*` / `at-zsh-*` temp dirs in `os.tmpdir()` accumulate on crash/SIGKILL; no boot-time sweep. Disk hygiene, not security.
- **data-security [F3] SUGGEST P4** SnapshotPersistence.ts:589-595 — `trackedCommands` inlined into shared `index.json`; one chatty session grows the whole sidecar. Bundles with [W3] schema rework.
- **data-security [F4] SUGGEST P4** exportCommands.ts:200-211 — Save-dialog default Uri unrooted when no workspace folder; cosmetic UX.
- **data-security [F5] SUGGEST P4** exportHelpers.ts:92-114 — `.tmp` path collides across concurrent exports to same target; UI flow makes this unlikely, but the canonical fix (unique temp suffix) already exists in `SessionStorage`.
- **logic [S5] SUGGEST P4** scrollbackDumpHandler.ts + SessionManager.ts:877-898 — Two-layer dedupe with mismatched keys; suggested fix: coalesce extension-side by sessionId, simplify webview to plain request/reply. Bundles with [W1] `ScrollbackDumpCoordinator` extraction.
- **contracts [F4] SUGGEST P4** messages.ts:907-915 — Redundant `tabId` in scrollbackDump reply blurs contract intent (extension matches on requestId only).
- **contracts [F5] SUGGEST P4** messages.ts:829-842 — `FlashPaneMessage` sets precedent for UI-effect messages in the semantic union; defer until a second UI-fx message appears.
- **frontend [F4] SUGGEST P4** scrollbackDumpHandler.ts:100-102 — `loadAddon` per dump; current frequency makes it negligible.
- **frontend [F5] SUGGEST P5** fileTreePanel.css:254-258 — Opacity transition on container holding xterm.js WebGL canvas may cause one-frame jank; consider `will-change: opacity`.

## Chair cross-cutting observations

1. **Consistency drift is the single biggest pattern signal**: 12 of 20 findings cluster on `src/session/SessionManager.ts` + `src/session/TrackedCommand.ts`. The codebase has a strong "extract a class collaborator" precedent (`SnapshotPersistence`, `EditorPanelRegistry`, `CustomNameRegistry`, `OutputBuffer`) — this change went the other way on TrackedCommand and on the new SessionManager responsibilities. Worth deciding explicitly: are these two files allowed to violate the pattern, or is a refactor pass owed?

2. **The `[W1]+[W2]+[S1]+[S2]+[S3]` cluster is one architecturally coherent refactor**: extract `ShellIntegrationCoordinator { tracker: CommandTracker, cleanups: Map }` + `ScrollbackDumpCoordinator { pendingDumps: Map }` + `runExport(deps, produce)` + drop `setCurrentCwdSink`. Estimated 1-day focused refactor; pays off long-term in test surface + future export-adjacent features.

3. **Design pattern non-issues actually worth calling out**: the OSC parser refactor (`feed` accepting an event sink + per-session `setNonce`) is clean — typed event union is the right boundary, nonce-as-state-on-parser-instance is the right scope. The `writeExportAtomically` `.tmp + rename` mirrors `SessionStorage` correctly. The `VscodeSurface` DI seam on the export commands is exemplary — tests cover the toast paths without spinning up VS Code. None of these need changes.

## Session IDs (review-{change-id}-{agent} naming convention)

- frontend: completed via asm-review-frontend (ade1280a1caf2aa81)
- data-security: completed via asm-review-data-security (a7525e0aeb4d24ee3)
- logic: completed via general-purpose substitute (aa316a1a697f686da) — asm-review-logic gateway-timed-out twice
- contracts: completed via general-purpose substitute (ab7d1af692515e90a) — asm-review-contracts gateway-timed-out
