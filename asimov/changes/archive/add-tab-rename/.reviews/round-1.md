# Review Round 1: add-tab-rename

**Date**: 2026-05-22
**Reviewable lines**: ~770 (under 800 threshold)
**Agents spawned**: logic, contracts, frontend
**Agents skipped**: data-security (no DB / secret / 3rd-party API surface — workspace state is local key-value with a user-supplied label string)
**Verdict**: **BLOCK** — 1 BLOCK + 2 WARN + 3 SUGGEST (no REJECT, < 3 BLOCK)

## Counts

| Severity | Count |
|---|---|
| BLOCK | 1 |
| WARN | 2 |
| SUGGEST | 3 |

## Findings

### B1 — Persistence race in `renameSession` can clobber a recently-saved custom name

- **Severity**: BLOCK
- **Confidence**: HIGH
- **Priority**: P1
- **Agent**: logic
- **Status**: accepted (will fix this round)
- **Triage**: Real race confirmed by walkthrough; user-visible (lost names on reload). Fix is small: in-memory authoritative Record.
- **File:line**: `src/session/SessionManager.ts:419` (the `renameSession` method body)
- **Evidence**: `renameSession()` performs a fire-and-forget load-modify-save on `workspaceState`. Sequence of two quick renames (different tabs):
  ```
  rename A: load → {}             (workspaceState empty)
  rename A: record = { "1": "A" }
  rename A: update() — async, queued
  rename B: load → {}             (A's update hasn't applied yet)
  rename B: record = { "2": "B" }
  rename B: update() — async, queued
  A's update applies: { "1": "A" }
  B's update applies: { "2": "B" }  ← clobbers A's entry
  ```
- **Impact**: After two quick renames of different tabs, the second rename's persisted record overwrites the first. In-memory `session.customName` looks correct; on reload, only B's name survives.
- **Suggested fix**: Hold an in-memory `Map<string, string>` (or `Record`) as the authoritative source of truth for persisted names. Read once on construction (hydrate from `workspaceState`). On each rename, mutate the in-memory map first, then enqueue a `workspaceState.update(KEY, { ...inMemoryMap })`. Sequential mutations of the same Map cannot race.
- **Status**: pending
- **Triage**: (set by chair after build)

### W1 — Inline-rename re-entry orphans the new rename's store state

- **Severity**: WARN
- **Confidence**: HIGH
- **Priority**: P2
- **Agent**: logic
- **Status**: accepted (will fix this round)
- **Triage**: Walkthrough confirms orphaned overlay state. Fix is a 2-line reorder.
- **File:line**: `src/webview/main.ts:144` (`startInlineRename`)
- **Evidence**: Sequence when an overlay for tab A is open and the user dblclicks tab B:
  1. `startInlineRename(B, ...)` calls `store.beginRename(B, ...)` → `store.renameSession = {tabId: B}`.
  2. `showRenameOverlay({...})` runs.
  3. Inside `showRenameOverlay`, `if (state) commit();` dismounts A's overlay AND fires A's `onCommit` callback.
  4. A's `onCommit` runs `store.endRename()` → `store.renameSession = null`.
  5. New state for B is set up; B's overlay is mounted.

  Net result: B's overlay is mounted but `store.renameSession === null`. Then:
  - `onAfterRender` (in `updateTabBar`) checks `store.renameSession` (null) → skips `repositionRenameOverlay()`. B's overlay drifts on subsequent re-renders.
  - `onTabRenamed(msg)` for B checks `store.renameSession?.tabId === msg.tabId` (null !== B) → does NOT dismount B's overlay via `hideRenameOverlay()`. Overlay persists after host echo.
- **Impact**: Orphaned overlay state in the webview. Visual drift when the tab bar re-renders; overlay isn't auto-cleaned when a parallel rename (context menu / F2 / command palette) lands a `tabRenamed` for the same tab.
- **Suggested fix**: Reorder in `startInlineRename` — call `showRenameOverlay` FIRST (which dismounts A's overlay + fires A's onCommit which calls `store.endRename()`), THEN call `store.beginRename(tabId, displayed)`. The new `beginRename` happens AFTER the prior `endRename`, so B's marker survives.
- **Status**: pending
- **Triage**: (set by chair after build)

### W2 — `getLastFocusedProvider` drops the visible sidebar when panel was last focused but now hidden

- **Severity**: WARN
- **Confidence**: HIGH
- **Priority**: P3
- **Agent**: logic
- **Status**: accepted (will fix this round)
- **Triage**: Method's docstring already promises the fallback; current impl doesn't deliver. Fix uses a small static instance set walked in epoch order.
- **File:line**: `src/providers/TerminalViewProvider.ts:660` (`getLastFocusedProvider`)
- **Evidence**: The method only checks the single static `_lastFocusedViewProvider`. If panel was focused last and panel is then hidden (`webviewView.visible === false`), the method returns `undefined` — even though the sidebar is still visible and has an active tab.
- **Impact**: Command-palette / F2 invocation no-ops when intuitively it should target the visible AT view. Realistic only in narrow workflows (panel hidden after focus, palette invocation without an intermediate sidebar click), but contradicts the method's docstring which says "most recently focused provider whose webview is still visible".
- **Suggested fix**: Track focus order across all `TerminalViewProvider` instances (a small static array or a focus-epoch counter per provider) and return the most recent provider with `_view?.visible === true`. Even simpler: maintain a static `Set<TerminalViewProvider>` of all instances, walk it in last-focused order, return first visible.
- **Status**: pending
- **Triage**: (set by chair after build)

### S1 — IME composition + programmatic focus steal can orphan the overlay

- **Severity**: SUGGEST
- **Confidence**: MEDIUM
- **Priority**: P4
- **Agent**: frontend
- **Status**: rejected (this round)
- **Triage**: Speculative scenario (concurrent IME composition + programmatic focus steal without compositionend). Fix is non-trivial (watchdog timer). Documented in `.reviews/` for future follow-up if real users report stuck overlays. Round-1 confidence MEDIUM; not blocking.
- **File:line**: `src/webview/tabRenameOverlay.ts:110` (`onBlur`)
- **Evidence**: `onBlur` synchronously checks `newState.composing`. If focus is stolen during composition (e.g. VS Code resize, focus call from outside), `blur` fires while `composing === true` → commit is suppressed. `compositionend` may never fire (the IME UI was tied to the input that just lost focus). Result: overlay mounted, `state` still pointing to it, no events route to it.
- **Impact**: Speculative — requires concurrent IME composition AND programmatic focus loss without `compositionend`. Affects IME users in unusual workflows; result is a stuck overlay invisible to subsequent commit triggers (until the user starts another rename which dismounts it).
- **Suggested fix**: Add a safety net inside `repositionRenameOverlay` (or a separate watchdog): when `state.composing === true` AND `document.activeElement !== state.input` for more than a tick, force `cancel()`. Alternatively, on `blur` while composing, schedule `setTimeout(forceCommit, 200)`.
- **Status**: pending
- **Triage**: (set by chair after build)

### S2 — `outline: none` on `.tab-rename-overlay` removes the focus indicator

- **Severity**: SUGGEST
- **Confidence**: HIGH
- **Priority**: P4
- **Agent**: frontend
- **Status**: accepted (will fix this round — trivial)
- **Triage**: A11y concern, fix is one CSS line.
- **File:line**: `src/providers/webviewHtml.ts:149` (CSS for `.tab-rename-overlay`)
- **Evidence**: `outline: none;` removes the browser default focus ring. The element does have a `border: 1px solid var(--vscode-focusBorder, #007acc)` at rest, but that's not a focus state — it's always present. Keyboard-only users have no visible distinction when the input gains focus.
- **Impact**: WCAG 2.4.11 (Focus Appearance, AA). Minor for an MVP UI but worth fixing.
- **Suggested fix**: Replace `outline: none` with `outline: none` scoped to `:not(:focus-visible)` and add `.tab-rename-overlay:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007acc); outline-offset: -1px; }`. Or simply remove `outline: none` and let the browser default render.
- **Status**: pending
- **Triage**: (set by chair after build)

### S3 — Overlay font-size hardcoded to 12px

- **Severity**: SUGGEST
- **Confidence**: MEDIUM
- **Priority**: P5
- **Agent**: frontend
- **Status**: accepted (will fix this round — trivial)
- **Triage**: One-line CSS var swap.
- **File:line**: `src/providers/webviewHtml.ts:144`
- **Evidence**: `.tab-rename-overlay { font-size: 12px; }` — the tab bar itself happens to also use 12px, but if the user adjusts VS Code zoom or font sizes, the overlay will visually misalign with the tab label it covers.
- **Impact**: Minor visual misalignment under non-default zoom/font-size.
- **Suggested fix**: `font-size: var(--vscode-font-size, 12px);` or `font-size: inherit;` (assuming the tab bar's font-size cascades).
- **Status**: pending
- **Triage**: (set by chair after build)

## Rejected by chair

### (Frontend #2) — Fallback to literal `tabId` in `buildTabBarData` is a UX defect
- **Reason**: Pre-existing code. The line `name: activeInstance?.name ?? rootInstance?.name ?? tabId` was unchanged by this change — only `customName: ...` was added next to it. Per review rules, unchanged code is not flagged unless CRITICAL security. The UUID-as-label race window is a real but pre-existing concern, not introduced by add-tab-rename.

## Notes

- The three agents reported that the Agent tool was unavailable in their context and ran the review directly. Findings appear thorough and traceable to specific files/lines, so they are accepted as-authored.
- No data-security findings: persistence is local `workspaceState` storing user-typed labels keyed by integer; no PII concern, no external transmission, host normalizes input via trim+truncate.
- Contracts agent found no issues: IPC additions are backward-compatible (missing `customName` defaults to `null` via existing `?? null` chains); package.json contributions follow VS Code conventions; public API additions are appropriate.
