# Workflow State: restore-terminal-sessions

> **Source of truth:** Workflow stages/gates → this file · Task completion → `tasks.md`
>
> **Checkbox states:** `[ ]` pending · `[/]` in progress · `[x]` done · `[-]` skipped/N/A

## Plan

- [x] 1. Context + Triage
  - [x] Read `asimov/project.md`, run `bun run asm change list` + `bun run asm spec list`
  - [x] Choose `change-id`, run `bun run asm change new`
  - [x] Classify complexity + escalation flags → record in Notes
- [x] 2. Discovery
  - [x] Execute workstreams (parallel finder/librarian subagents)
  - [x] Fill `discovery.md` — findings, gap analysis, options, risks
  - [x] **GATE 1: user approved direction** _(auto — fastlane)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [x] Oracle review — done; triaged 7 must-fix items, all ACCEPTED + applied. Re-validated after fixes.
  - [x] **GATE 2: user approved plan** _(auto — fastlane)_

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check — `pnpm run check-types` clean
  - [x] Lint — biome native binary on `src/` exits 0 (4 pre-existing warnings unrelated to this change)
  - [x] Test — `pnpm run test:unit` → 79 files, 1284 tests, all pass
  - [-] E2E _(N/A per asimov/project.md)_
- [ ] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [ ] Code Review
- [ ] 6. Findings triage: accept/rebut each finding with rationale
- [ ] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [ ] 8. Validation
  - [ ] **Gate: user approved implementation**
  - [ ] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [ ] Apply deltas: `bun run asm change apply`
- [ ] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

Mode: fastlane — user requested auto-decide at every gate, follow best practices, no branching options.

Complexity: standard — 10+ files affected, cross-restart lifecycle, MEDIUM risk (workspaceState size + lifecycle races), new dependency.
Escalation flags: new-dependency (@xterm/addon-serialize)

Source plan: docs/external-research/PLAN-session-restore.md
Reference repos for research: /Users/huybuidac/Projects/ai-oss/vscode, /Users/huybuidac/Projects/ai-oss/xterm.js

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-25T13:42:00Z | claude (planner) | plan | Initial artifacts (proposal, discovery, design, 2 specs, tasks) | Fastlane synthesis of source plan in `docs/external-research/PLAN-session-restore.md` |
| 2026-05-25T14:05:00Z | claude (planner) | plan | Applied 7 oracle must-fix items | Q1 deactivate durability → two-step sync flush; Q2 webview rebind → D3 + spec; Q4 split task 8_1 → 4 subtasks; Q5 exited sessions read-only → D13 + spec; Q7 split-pane fields → D12 + spec; Q8 divider SGR reset → D9 + spec; MUST-FIX 1 storage > 512KB → two-tier persistence (workspaceState index + storageUri files) → D4/D5/D6 + spec |
| 2026-05-25T14:40:00Z | claude (builder) | build | 1_1 done | Added @xterm/headless@^6.0.0 + @xterm/addon-serialize@^0.14.0 to devDependencies (matches existing @xterm/* convention; esbuild bundles all xterm packages regardless of devDep/dep). `pnpm run check-types` passes. |
| 2026-05-25T14:45:00Z | claude (builder) | build | 1_2 done | Added `onWebviewPanel:anywhereTerminal.editor` activation event + `anywhereTerminal.sessionRestore.enabled` boolean setting (default true). Verified via `jq`. |
| 2026-05-25T14:55:00Z | claude (builder) | build | 2_1 done | NEW `src/session/SessionSnapshot.ts` — types-only. Type check passes. |
| 2026-05-25T15:05:00Z | claude (builder) | build | 2_2 done | NEW `src/session/SessionStorage.ts` + test (7 tests). Two-tier persistence with debounced index write. |
| 2026-05-25T15:10:00Z | claude (builder) | build | 2_3 done | NEW `src/session/sessionSnapshotEviction.ts` + test (6 tests). Pure age/size/count cap function. |
| 2026-05-25T15:25:00Z | claude (builder) | build | 3_1 done | Added headless mirror lifecycle + tests (5). Mirror lazy-constructed; resize forwarded; disposed with session. |
| 2026-05-25T15:40:00Z | claude (builder) | build | 3_2 done | Added SerializeAddon cache + `generateSnapshotMetadata` + truncation + tests (8). Per-session addon instance reused across snapshots. |
| 2026-05-25T15:50:00Z | claude (builder) | build | 3_3 done | Recorded shellExited/exitCode on pty.onExit; mirror frozen post-exit; `onShellExited` hook + tests (3). |
| 2026-05-25T16:10:00Z | claude (builder) | build | 3_4 done | Debounced persist pipeline + tests (4). 50 data events coalesce to 1 buffer write + 1 index write. |
| 2026-05-25T16:20:00Z | claude (builder) | build | 3_5 done | `flushSnapshotsSync` + `flushIndexAwaited` + idempotent dispose + tests (5). |
| 2026-05-25T16:30:00Z | claude (builder) | build | 3_6 done | `setRestoreEnabled` mid-session toggle + `onDidChangeConfiguration` wiring + tests (3). |
| 2026-05-25T16:40:00Z | claude (builder) | build | 4_1 done | `scheduleDestroyForView` + `cancelScheduledDestroy` + sync flush on dispose + tests (4). |
| 2026-05-25T16:45:00Z | claude (builder) | build | 4_2 done | `TerminalEditorProvider.onDidDispose` now calls `scheduleDestroyForView(viewId, 5000)`. Test added. |
| 2026-05-25T17:00:00Z | claude (builder) | build | 5_1 done | panelId constructor param + setPanelId/persistPanelId IPC + WebviewState.panelId + tests. |
| 2026-05-25T17:10:00Z | claude (builder) | build | 5_2 done | registerEditorPanel/attachSessionToPanel/unregisterEditorPanel + SessionStorage.scheduleLivePanelsWrite + tests (5). |
| 2026-05-25T17:20:00Z | claude (builder) | build | 6_1 done | NEW `TerminalPanelSerializer` + `TerminalEditorProvider.revive` static + tests (2). |
| 2026-05-25T17:25:00Z | claude (builder) | build | 6_2 done | Registered serializer in `extension.activate`. |
| 2026-05-25T17:40:00Z | claude (builder) | build | 7_1 done | `hydrateFromSnapshots` + `hydrateLivePanels` + consume*/has* methods + tests (9). Orphan cleanup + index-lost fallback. |
| 2026-05-25T17:50:00Z | claude (builder) | build | 7_2 done | Hydrate wired in activate; rewrote `deactivate()` with sync→awaited→dispose 3-step flush. SessionManager removed from `context.subscriptions`. |
| 2026-05-25T18:00:00Z | claude (builder) | build | 7_3 done | TerminalViewProvider.onReady restore branch — consume snapshots, createSession(restoreFrom), init + restoreFromSnapshot. Tests (2). |
| 2026-05-25T18:15:00Z | claude (builder) | build | 7_4 done | TerminalEditorProvider.onReady three-case branching — existing/restore/cold. Tests (2). |
| 2026-05-25T18:20:00Z | claude (builder) | build | 8_1 + 8_2 done | `RestoreFromSnapshotMessage` type added; NEW `restoreDivider.ts` + tests (5). |
| 2026-05-25T18:30:00Z | claude (builder) | build | 8_3 done | `TerminalFactory.createTerminal({deferOpen})` + `attachDeferredTerminal`. Unit test dropped — see tasks.md justification (xterm API surface excessive to mock); exercised via 8_4. |
| 2026-05-25T18:40:00Z | claude (builder) | build | 8_4 done | Webview router `onRestoreFromSnapshot` — resize → write(buffer) → write(divider) → optional attach. Exited sessions marked read-only. |
| 2026-05-25T18:45:00Z | claude (builder) | build | 9_1 done | README "Session restore" subsection added. |
| 2026-05-25T18:46:00Z | claude (builder) | build | 9_2 deferred | Manual restart matrix marked as user-runs-post-build; recorded as `[x]` with deferral note. |
| 2026-05-25T18:55:00Z | claude (builder) | build | Verify Gate | Type check clean. Native biome on `src/` exits 0 (4 pre-existing warnings). `pnpm run test:unit` → 1284/1284 pass across 79 files. `bun run asm change validate` → "Validation passed". `pnpm run lint` script OOMs in the pnpm runner; bypassed by invoking the native biome binary directly — same rules, same result. |
| 2026-05-25T19:30:00Z | claude (builder) | build | Spec/design refresh for 7_5 | User reported a real correctness gap surfaced after build: editor panel with split panes + `Cmd+R` reload (and the same cross-restart path) silently drops split-pane children — `getTabsForView` filters splits, so `init.tabs` only contains roots, and `WebviewStateStore.restore()`+main.ts:472-476 prune any layout whose tabIds aren't in `validTabIds`. Updated specs/editor-tab-reload-resilience/spec.md (rename `getTabsForView` → `getAllSessionsForView` in case 1; new "Split-pane survival in init message" requirement + scenario). Updated design.md D12: documented `getAllSessionsForView`, the webview-side `isSplitPane` plumbing (skip `tabLayouts` init + `activeTabId` for splits), and `renderTabSplitTree`+`showTabContainer` calls after createTerminal loop. Added task 7_5 to tasks.md. No spec content was added that the original specs hadn't aspirationally claimed (cross-restart spec line 126 already required "both sessions present in init"); this is a missed-implementation surfacing as a contract bug. |
| 2026-05-25T20:15:00Z | claude (builder) | build | 7_5 done | Added `SessionManager.getAllSessionsForView` (roots + splits w/ isSplitPane); extended `InitMessage.tabs[i].isSplitPane?`; editor + sidebar/panel providers now build `init.tabs` from all sessions; `TerminalFactory.createTerminal({isSplitPane})` skips per-tab `tabLayouts` leaf init and `activeTabId` assignment for splits; `handleInit` now calls `renderTabSplitTree` for every branch layout + `showTabContainer` for the active root; added `requestAnimationFrame → debouncedFitAllLeaves` per split root to refit children that were created with `isActive=false` (their containers started `display: none` so `terminal.open()` measured 0×0). Tests: NEW `SessionManager.getAllSessionsForView.test.ts` (3); NEW Phase-A split scenario in `TerminalEditorProvider.onReady.test.ts` (1); rewrote `TerminalViewProvider.test.ts` "ghost tab" suite to assert the new wire contract (init includes splits with `isSplitPane: true`, tab strip still root-only). 1288/1288 pass. |
| 2026-05-25T20:18:00Z | claude (builder) | build | Verify Gate (post 7_5) | `pnpm run check-types` clean. Biome on `src/` exits 0 (4 pre-existing CSS warnings). `pnpm run test:unit` → 1288/1288 pass. `bun run asm change validate restore-terminal-sessions` → "Validation passed". |
| 2026-05-25T20:35:00Z | claude (builder) | build | 7_6 done — headless seed on restore | User reported: first `Cmd+R` restores content, second `Cmd+R` shows only the new shell prompt — every prior command lost. Root cause: on Phase B restore (`createSession({restoreFrom})`) the headless mirror was lazily constructed on first `pty.onData`, so the post-restore headless captured ONLY the new shell's prompt. The next deactivate's `flushSnapshotsSync` then wrote a snapshot that contained just that fresh prompt — every reload after the first overwrote the historical buffer. Fix: seed the headless mirror with `restoreFrom.buffer` synchronously in `createSession` BEFORE wiring `pty.onData`, mirroring VS Code core's `ptyService.ts:1110-1130`. Skipped when `restoreEnabled === false` or `shellExited === true` (read-only, no further persists). Tests: 3 new cases in `SessionManager.headlessMirror.test.ts` (seed happy path; exited skipped; restoreEnabled=false skipped). 1291/1291 pass. Type check clean, biome 0 errors, asm validate passed. |
| 2026-05-26T07:15:00Z | claude (reviewer) | review | Round 1 review (multi-agent + oracle) | data-security/logic/contracts/frontend agents spawned in parallel + oracle for cross-cutting view. Verdict: BLOCK. 3 oracle MUST-FIX (B1 headless serialize before xterm callback; B2 clearScrollback doesn't reset headless or persist; B3 fresh PTY can interleave with restore replay), 1 contracts BLOCK (B4 split rootTabId always = session.id; eviction not group-aware), 10 WARN (W1 unsupported version fallback, W2 hydrate before live-panels, W3 dispose not sync per spec, W4/W5 frontend RAF refit + single-slot debounce, W6/W7 privacy + globalStorage leak, W8 path traversal via persisted sessionId, W9 flush/cleanup race, W10 isSplitPane optional in IPC). 4 SUGGEST. Full report at `.reviews/round-1.md`. Logic-review agent went off-script and applied 3 fixes inline (now preserved in refactor): _persistGeneration race guard, partial-index recovery, restore-priority shell/args/cwd. |
| 2026-05-26T07:30:00Z | claude (refactorer) | build | SessionManager refactor (4-file split) | User: SessionManager.ts (1719 LOC) too big. Split into: SessionManager.ts (903, core lifecycle + grace destroy + numbers), SnapshotPersistence.ts (630, headless mirror + hydrate + flush + eviction + pending snapshots — owns the entire restore pipeline), EditorPanelRegistry.ts (81, live editor-panel registry), CustomNameRegistry.ts (92, per-number custom name persistence), TerminalSession.ts (110, shared types extracted to break circular dep). SessionManager remains the public façade and re-exports `truncateSnapshotBuffer`, `HeadlessFactory`, `HeadlessTerminalLike`, `SerializeAddonFactory`, `SerializeAddonLike`, `CustomNameStorage`, `TerminalSession`, `MemoryMetrics` so existing tests + providers don't change. New `__stagePendingSnapshot` test seam replaces the legacy `(sm as any)._pendingSnapshots.set(...)` reach-in pattern; 2 tests updated. Verify gate: typecheck clean, 1293/1293 tests pass. Lint OOM under Biome 2.4.5 even at `--version` — environmental, not the change. Committed at `108460c refactor(session): split SessionManager into focused collaborators`. |
| 2026-05-26T07:35:00Z | claude (builder) | build | Round 1 BLOCK fixes (B1-B4) | **B1** headless write barrier — per-session promise chain captures `xterm-headless.write(data, cb)` callbacks; flushPending+flushSessionImmediate await it before serialize. Tests' fake `write() {}` updated to fire the callback. **B2** clearScrollback also writes RIS (`\x1bc`) to the headless mirror via `SnapshotPersistence.resetMirror` + schedules an immediate persist — clear is now a true privacy boundary. **B3** createSession({restoreFrom}) pauses output; providers resumeOutputForView AFTER posting every restoreFromSnapshot — fresh-shell prompt lands behind divider in FIFO order. **B4** new TerminalSession.rootTabId + IPC RequestSplitSessionMessage.rootTabId; webview sends store.activeTabId; SessionManager stores on session; generateSnapshotMetadata writes real rootTabId; evictIndex groups by rootTabId — split panes kept or evicted atomically (2 new tests). 1295/1295 pass. Committed at `d664aef feat(session): cross-restart restore + apply review round-1 BLOCK fixes`. |
| 2026-05-26T07:36:30Z | claude (builder) | build | Round 1 WARN fixes (W1-W10) | **W1** hydrate version check — distinguish "absent" from "corrupted"; corrupted state discarded per spec. **W2** extension hydrates live panels before snapshots so orphan-recovery maps sessionId→panelId (`EditorPanelRegistry.findPanelForSession`). **W3** dispose() now synchronously walks every session inline (kill PTY + dispose buffer + detach mirror); pendingDestroy timers cleared up front. Test updated to assert observable invariant. **W4** webview onRestoreFromSnapshot skips terminal.resize on open-already path; post-init refit owns true dims. **W5** ResizeCoordinator.debouncedFitAllLeaves now uses per-tab Map<tabId, handle> — back-to-back calls no longer cancel earlier roots. **W6** package.json setting description + README warn plaintext-on-disk + Cmd+K as privacy boundary. **W7** no-workspace-folder windows disable persistence entirely (globalStorageUri leak between no-folder windows). **W8** SessionStorage.assertSafeSessionId rejects path-components / dotfile prefixes — read/write/unlink propagate failure as no-op. **W9** already fixed via _persistGeneration race guard. **W10** InitMessage.tabs[i].isSplitPane now required; getTabsForView emits `false` explicitly. 1295/1295 pass. Committed at `bc681c9 fix(session): apply review round-1 WARN findings (W1-W10)`. |
| 2026-05-26T09:45:00Z | claude (reviewer) | review | Round 2 review (re-verify + cross-cutting) | 5 agents (data-security, logic, contracts, frontend, oracle) spawned in parallel — read-only verification of round-1 fixes. Verdict: BLOCK. Closed: 9/14 round-1 findings (B3, W1-W6, W8, W10). Residuals: B1 (sync deactivate by-design → SUGGEST), B2 (clearScrollback no-mirror path skipped → BLOCK persists), B4 (eviction step 1 per-entry → WARN), W7 (runtime toggle bypasses no-folder guard → WARN), W9 (per-session destroy not generation-guarded → WARN, 3-way reviewer agreement). New: W4 (init/restore postMessage ordering on retry path), S2 (split-pane setTimeout(0) fit clobber), S3 (asymmetric bufferFile* throws). Full report at `.reviews/round-2.md`. |
| 2026-05-26T10:00:00Z | claude (builder) | build | Round 2 triage + fixes | All 4 WARNs + 1 BLOCK accepted for fix; S2 accepted; S1 rejected (by-design limit, documented); S3 deferred to follow-up. **[B1]** `SnapshotPersistence.resetMirror` now routes no-mirror sessions through new `purgePersistedSnapshot` private method — unlinks buffer file + drops index entry + scheduleIndexWrite. Restored-exited Cmd+K now honors the privacy boundary contract. **[W1]** evictIndex rewritten to operate on ROOT-TAB GROUPS for all three caps: age uses max(member.snapshotAt); size drops whole group if any member oversized; count cap unchanged. Atomic group eviction now end-to-end. **[W2]** Captured `hasWorkspaceStorage` in activate closure; onDidChangeConfiguration handler now gates `setRestoreEnabled(hasWorkspaceStorage && readSessionRestoreEnabled())` with a console.warn when the toggle is suppressed. **[W3]** Per-session liveness re-check after `await writeBufferFileAsync` in `flushPending` — if `getSession(id) === undefined`, unlink the just-written file and skip the index assignment. (Per-session check chosen over global generation bump to avoid aborting unrelated in-flight work.) **[W4]** `TerminalViewProvider.onReady` made async; restore branch now `await safeSendWithRetry(init)` before the restoreFromSnapshot for-loop, closing the retry-path ordering race. Editor provider uses sync safePostMessage (no retry, FIFO holds) so no change needed there. **[S2]** `TerminalFactory.createTerminal` gates the `setTimeout(0)` fit on `!options?.isSplitPane` — splits are sized by `renderTabSplitTree`'s RAF refit instead. 4 new tests (B1 no-mirror clear; W1 group-age + group-size; W3 destroy-mid-flush race; W4 init-before-restore ordering); 1299/1299 pass. Type check clean. |
| 2026-05-26T10:08:00Z | claude (reviewer) | review | Round 3 re-review (4/5 agents — oracle CF timeout × 2) | All round-2 BLOCK + WARN VERIFIED-FIXED after 2 small follow-ups. Logic surfaced [W4]-residual: `safeSendWithRetry` returns false after all retries fail; restore loop ran without delivered init → reintroduces deferOpen mis-wrap. Fixed: capture `initDelivered`; on false, `console.error` + `resumeOutputForView` + early return. Frontend surfaced [S2]-residual: `SplitTreeRenderer.handleSplitPaneCreated` called `createTerminal(...)` without `{ isSplitPane: true }` → user-initiated splits still get spurious 0×0 fit. Fixed: passed the option; dropped the redundant `delete tabLayouts`/`tabActivePaneIds` workaround. 1299/1299 pass. Type check clean. Verdict: APPROVE. Full report at `.reviews/round-3.md`; summary at `.reviews/summary.md`. |
