# Workflow State: add-tab-rename

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
  - [/] **GATE 1: user approved direction** _(skip for trivial)_
- [x] 3-6. Artifact Generation (batch)
  - [x] Fill proposal.md (why, appetite, scope, risk, E2E decision)
  - [x] Fill specs/ — scenarios only when they pin acceptance beyond the requirement (default = none)
  - [x] Fill design.md _(standard or escalation-forced — skip if LOW risk + no escalation flags)_
  - [x] Fill tasks.md (deps, refs, done, test, files, approach)
- [x] 7. Validation
  - [x] `bun run asm change validate` passes
  - [x] Oracle review _(REVISE → revised → user approved without re-oracle)_
  - [x] **GATE 2: user approved plan**

## Implement

<!-- RULE: NEVER delete or overwrite ## Implement, ## Archive, ## Notes, or ## Revision Log sections.
     Use `edit` (not `write`) on workflow.md — only update checkboxes, Notes, or Revision Log. -->
<!-- RULE: After completing each task, immediately mark it [x] in tasks.md AND log in Revision Log below. -->
- [x] 1. Read all change artifacts that exist (workflow.md, specs/, proposal.md, design.md, tasks.md)
- [x] 2. Execute tasks sequentially in dependency order
- [x] 3. Update: mark `- [x]` in tasks.md + log in Revision Log after EACH task
- [x] 4. Verify Gate — run commands from `asimov/project.md` § Commands, **MUST execute and observe pass** _(mark `[-]` if N/A)_:
  - [x] Type check
  - [x] Lint
  - [x] Test
  - [-] E2E
- [x] 5. Review (adaptive — skip for trivial or doc/design-only):
  - [x] Code Review
- [x] 6. Findings triage: accept/rebut each finding with rationale
- [x] 7. Review Fix Loop _(max 3 rounds — fix, re-verify, re-review)_
- [x] 8. Validation
  - [x] **Gate: user approved implementation**
  - [/] Extract knowledge

## Archive

- [ ] Deploy Gate _(skip if `asimov/project.md` § Commands → Deploy is N/A)_:
  - [ ] Run deploy command
  - [ ] Run smoke test
- [ ] Apply deltas: `bun run asm change apply`
- [ ] Archive change: `bun run asm change archive`
- [ ] Commit all changes

## Notes

_(Key decisions, blockers, user feedback — persists across compaction)_

**Intent (confirmed at triage)**: User can rename a terminal tab to give it a custom label.

**Complexity: standard**
- Multi-layer change: webview UI (tab edit) → IPC → extension host (session label state)
- Interacts with existing `process-title-tracking` (auto-rename) — UX decision needed: custom name overrides auto?
- Interacts with `session-manager-numbering` (default labels)
- Persistence question: do custom names survive reload? (affects storage layer)

**Escalation flags**: none of new-dependency / public-API-change / data-migration / security / perf concerns. UX-decisions flag → design.md needed for UX trigger + persistence + auto-rename interaction.

**Related specs to extend**: `tab-bar-component`, `session-manager-core`, `process-title-tracking`, plus likely new spec for the rename capability itself.

## Revision Log

<!-- Format: YYYY-MM-DDTHH:MM:SSZ (ISO 8601 UTC). Get timestamp: date -u +%Y-%m-%dT%H:%M:%SZ -->

| DateTime (UTC) | Author | Phase | What Changed | Why |
| -------------- | ------ | ----- | ------------ | --- |
| 2026-05-22T01:57:44Z | planner | Stage 1 | Triage: standard complexity, UX-decisions escalation flag → design.md required | OSC auto-rename collision + persistence model + new context-menu webviewSection raise UX-shape decisions |
| 2026-05-22T01:57:44Z | planner | Stage 2 | Discovery complete: 7 findings, 3 orthogonal UX decisions (D1/D2/D3), 5 risks identified | Auto-rename via OSC titles will fight custom names → needs explicit priority field; persistence is greenfield (no existing session-name storage); tab context menu is new surface |
| 2026-05-22T01:57:44Z | planner | Gate 1 | User picked D1.A (sticky custom) + D2.C (dblclick inline + right-click + command) + D3.B (workspace persistence by number) + F2 default keybinding | Most discoverable UX combination; matches VS Code conventions |
| 2026-05-22T01:57:44Z | planner | Stages 3-6 | Batch-wrote proposal.md, 6 spec deltas (tab-rename ADDED, session-manager-core/process-title-tracking/tab-bar-component/terminal-context-menu/split-focus-management MODIFIED), design.md (7 D's + risk map + interfaces), tasks.md (5 sections, 12 tasks) | All artifacts produced in one batch — no intermediate reads |
| 2026-05-22T01:57:44Z | oracle | Stage 7 | REVISE: 3 critical/major gaps — (1) renderTabBar wipes DOM so inline-edit guard is unsound, (2) no focused-tab resolution for editor webview panels (TerminalEditorProvider instances are discarded), (3) getActiveSessionId returns active pane not root tab. Plus: split-pane number collision on persistence, spec contradicts D5 on IPC, command-palette-vs-menu label split, Memento.update async ambiguity, missing protocol-docs task | Independent review caught architectural gaps that would have blocked the builder |
| 2026-05-22T01:57:44Z | librarian | Stage 7 | VSCode terminal rename research persisted to docs/research/20260522-vscode-terminal-rename.md — answers inline-edit DOM strategy, focused-terminal fallback chain, persistence shape, F2/tabsFocus scoping, command-label-via-category pattern, reset semantics | User-supplied local clone of vscode + xterm.js; high-confidence patterns to mirror |
| 2026-05-22T01:57:44Z | planner | Stage 7 | Revised: design.md rewritten (D1-D9 incl. new D8 command-label/D9 async-Memento), tab-rename spec fixes IPC contradiction + split-pane persistence exclusion + overlay-input requirement, session-manager-core spec gates persistence/hydration to !isSplitPane, terminal-context-menu spec drops wrong commandPalette override, tab-bar-component spec switches to overlay scenario, tasks.md reorganized into 15 tasks (4_2 split into overlay-module + dblclick-wiring, 4_3 split into view-getActiveTabId + editor-instance-registry + command-handler + keybinding, new section 5 for protocol docs, new test task 6_3 for command resolution) | Addresses all 3 oracle critical/major gaps + minor findings; incorporates VSCode patterns (category-based palette label, focused-host chain, external edit state) |
| 2026-05-22T01:57:44Z | planner | Stage 7 | `bun run asm change validate add-tab-rename` passed after revision | Sanity check |
| 2026-05-22T01:57:44Z | user | Gate 2 | Approved revised plan; opted to skip re-oracle | Revisions concretely address each oracle finding |
| 2026-05-22T01:57:44Z | builder | Build | Section 1 (1_1–1_4): added `customName` field + CustomNameStorage dep + load/save/normalize helpers + `renameSession` API to SessionManager; wired extension.ts to pass `context.workspaceState`. Type-check + 825 existing tests pass. Unit tests for the new API consolidated in 6_1 | Tight coupling within one file; per-task minimal tests would duplicate 6_1 |
| 2026-05-22T01:57:44Z | builder | Build | Section 2 + 3 (2_1, 2_2, 3_1, 3_2): added `RenameTabMessage`/`TabRenamedMessage`, extended `init`/`tabCreated` payloads with `customName`, routed `renameTab` in both providers (delegates to `SessionManager.renameSession`), added `onTabRenamed` slot to `MessageRouter` + handler in main.ts, threaded `customName` through `TerminalInstance`/`TabInfo`/`buildTabBarData`/`createTerminal`, made `renderTabBar` use `customName ?? name`. Updated three test fixtures (MessageRouter.test.ts, webviewFlows.test.ts) for new types. Type-check + 825/825 tests pass | Coupling across IPC + render layer; doing 2+3 together avoided multiple intermediate broken-build states |
| 2026-05-22T01:57:44Z | builder | Build | Section 4 (4_1, 4_2a, 4_2b, 4_3a–d): added `data-vscode-context='terminalTab'` + dblclick handler to tab DOM, declared `anywhereTerminal.renameTab` command (category: AnyWhere Terminal) + `tab@1` menu entry + F2 keybinding (sidebar/panel/editor; no `secondary` — confirmed not registered) in package.json, built `src/webview/tabRenameOverlay.ts` (absolutely-positioned input, ResizeObserver + window.resize + after-render reposition, IME suppression, Enter/Escape/blur with idempotency guard), added `renameSession` state + `beginRename`/`endRename` to WebviewStateStore, added `getActiveTabId()` + static last-focused tracking (set in `focus` IPC handler) to TerminalViewProvider, added `_instances` registry + `getActiveProvider()` + `getActiveTabId()` to TerminalEditorProvider, registered `anywhereTerminal.renameTab` command handler in extension.ts with D5 resolution chain (arg → editor.active → lastFocusedView → silent no-op) opening `showInputBox` seeded with `customName ?? name`. Type-check + 825/825 tests pass | Many small pieces but each was straightforward; consolidated commit because cross-references between them (renameTab command depends on overlay's IPC contract + editor registry + view tracker) |
| 2026-05-22T01:57:44Z | builder | Build | Section 5 (5_1): updated docs/design/message-protocol.md §3 (WV→Ext catalog + types for `renameTab`), §4 (Ext→WV catalog + types for `tabCreated.customName` + `tabRenamed`), §11.1 struck `rename` row as "landed in add-tab-rename" | Protocol doc was the planned home; spec reference points back here |
| 2026-05-22T01:57:44Z | builder | Build | Section 6 (6_1, 6_2, 6_3): added 16 SessionManager tests (normalization, broadcast, split-pane no-op, persist upsert+delete, fire-and-forget under failing update, hydration on recycled number, getTabsForView includes customName), 12 TabBar+overlay tests (customName ?? name priority, exited-suffix, data-vscode-context, dblclick hook, IME suppression, Enter/blur idempotency, target-removal cancel), and 8 command-resolution tests (arg → editor → focused-view → undefined chain; extracted resolveRenameTargetTabId() into pure module for testability). 869/869 pass | Extraction enabled clean unit tests without needing to mock vscode.commands.registerCommand |
| 2026-05-22T01:57:44Z | builder | Verify | All gates pass: tsc (clean), biome (4 files auto-formatted, 0 errors), vitest (869/869, 44 new), E2E marked N/A per project.md. Note: pnpm-wrapped biome OOMs in this harness; biome invoked directly works fine | Wrapper harness anomaly, not a real failure |
| 2026-05-22T01:57:44Z | reviewer | Review R1 | BLOCK verdict: 1 BLOCK (B1 persistence race) + 2 WARN (W1 startInlineRename ordering, W2 focus-fallback) + 3 SUGGEST (S1 IME orphan, S2 outline a11y, S3 font-size). Findings in `.reviews/round-1.md` | Three expert agents (logic, contracts, frontend); contracts clean, data-security not spawned (no DB/secret surface) |
| 2026-05-22T01:57:44Z | builder | Triage R1 | Accepted B1 + W1 + W2 + S2 + S3 for round-2 fix; rejected S1 (speculative + non-trivial). Details in `.reviews/round-1.md` Triage fields | Round-2 fix loop initiated |
| 2026-05-22T01:57:44Z | builder | Fix R1 | B1: replaced load-modify-save with constructor-hydrated in-memory `Map<string, string>` + snapshot writes; added regression test that replays the race. W1: swapped `showRenameOverlay`/`beginRename` order in `startInlineRename`. W2: replaced single `_lastFocusedViewProvider` pointer with `_focusOrder: TerminalViewProvider[]` recency stack + `unmarkFocused()` in dispose. S2: split `outline: none` into `:not(:focus-visible)` + `:focus-visible` rules. S3: `font-size: var(--vscode-font-size, 12px)`. tsc + biome + 874/874 vitest all pass | Round-2 verification |
| 2026-05-22T01:57:44Z | reviewer | Review R2 | APPROVE: 0 BLOCK, 0 WARN, 0 new findings. All rebuttals Overruled (fixes work). S1 deferral Sustained. Findings in `.reviews/round-2.md` | Exit criteria met; review fix loop closed |
| 2026-05-22T01:57:44Z | builder | Bug | User-reported: dblclick on tab does nothing. Root cause: switchTab re-renders the entire tab bar (`innerHTML = ""`) on first click, so the second click lands on a new DOM element — browser native `dblclick` keys on element identity and never fires. Fix: removed native `dblclick` listener, added manual click-epoch detection in the `click` handler (lastTabClick = {tabId, time}; second click within 350ms on same tabId fires onTabRename instead of onTabClick). Added 3 new tests + module reset hook. esbuild rebuilt. tsc + biome + 875/875 vitest pass | Native dblclick incompatible with destructive re-renders |
| 2026-05-22T01:57:44Z | builder | Bug | User-reported: F2 in terminal does nothing. Root cause: xterm's `attachCustomKeyEventHandler` returns true for non-modifier keys; xterm then processes F2 (sends `\x1bOQ` escape sequence to PTY) and calls preventDefault(), eating the keystroke before VS Code's keybinding layer can match `anywhereTerminal.renameTab`. Fix: added `if (event.key === "F2") return false;` branch in `createKeyEventHandler` (`src/webview/InputHandler.ts`) so xterm skips processing and the event propagates up to VS Code. Added 2 unit tests in `InputHandler.test.ts`. esbuild rebuilt. tsc + biome + 877/877 vitest pass | Existing modifier-keyed bindings (Ctrl+\) work because VS Code's keybinding layer matches Ctrl/Cmd combos before xterm sees them; unmodified function keys need an explicit passthrough |
| 2026-05-22T01:57:44Z | builder | Scope | User decision: drop F2 default keybinding entirely. Reverted: package.json keybindings entry, InputHandler.ts F2 passthrough branch, 2 InputHandler.test.ts F2 tests. Updated specs/tab-rename/spec.md (removed F2 from entry-points list, added note that users can self-bind via Keyboard Shortcuts UI). Updated design.md D6 (was "F2 when clause", now "No default keybinding ships" with rationale). asm validate passes; esbuild rebuilt; tsc + biome + 875/875 vitest pass | Avoids brittle xterm passthrough; users still have right-click + command palette + dblclick as triggers |
| 2026-05-22T01:57:44Z | user | Gate 8 | Approved implementation — dblclick + right-click + command palette confirmed working in dev host; F2 dropped by user choice | Ready for knowledge extraction + archive |
