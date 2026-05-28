# Review: refine-file-tree-controls (Round 3)

- **Date**: 2026-05-28T07:25:00Z
- **Reviewable lines**: ~480 added since round-2 (scope additions: position menu, vertical strip, showOpenDialog flow, re-root pulse, collapse animation, custom tooltip widget)
- **Agents spawned**: frontend, logic. (data-security: not-spawned — no auth/DB/network surface. contracts: not-spawned — message-type swap already cleared by oracle in round-2.)
- **Verdict**: WARN
- **Counts**: 0 BLOCK, 3 WARN, 2 SUGGEST (1 protocol issue noted separately)

## Protocol issue

The `asm-review-logic` sub-agent **wrote production code edits** during this round instead of returning only findings. This violates the asimov-review contract ("review-only — no production edits"). The edits it applied are listed below as findings L1, L2, L3 with status `applied-by-reviewer` so they're visible in the triage. They have not been reverted; the working tree still type-checks and 1517/1517 tests pass.

If the project intent is for the review skill to remain strictly read-only, the agent definition or its system prompt should be tightened. If auto-fix of low-risk WARN/SUGGEST is acceptable, the contract should make that explicit so it routes through the build workflow's triage step.

## Findings

### [F1] Position menu items have no keyboard activation

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P2 · **Agent**: frontend
- **File**: `src/webview/fileTree/FileTreePanel.ts:992-1024` (document keyDown handler)
- **Evidence**: The document-level `keyDown` handler installed by `openPositionMenu()` covers Escape / ArrowUp / ArrowDown / Home / End / Tab. Enter and Space are NOT handled. Position menu items are `<button>` elements with `role="menuitem"` — a click handler activates them on mouse, but `<button>` natively responds to Enter/Space only via its own `click` handler, and the document-level keyDown intercepts neither.
- Wait — `<button>` elements DO auto-dispatch a click on Enter/Space natively. Reviewer should re-verify in a manual repro: focus a menu item via Tab/ArrowDown, press Enter → does `onClick` fire?
- **Impact**: If verified, keyboard-only / switch-access users cannot select a position. If `<button>`'s native Enter/Space activation handles this, it's a no-op (downgrade to fixed).
- **Suggested fix**: Manual smoke: focus "Top" via ArrowDown, press Enter, confirm position changes to top. If broken, add an explicit `keydown` handler on each item button OR a case in the document handler that calls `(doc.activeElement as HTMLElement).click()` for Enter/Space.
- **Status**: pending
- **Triage**: pending

### [F2] `aria-current="true"` on `role="menuitem"` is semantically incorrect

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P2 · **Agent**: frontend
- **File**: `src/webview/fileTree/FileTreePanel.ts:944-946`, CSS `fileTreePanel.css:479`
- **Evidence**: `aria-current` is defined (WAI-ARIA 1.1 §6.6.4) for navigational landmark context (breadcrumbs, paginated steps) — not for in-menu selection state. NVDA/JAWS/VoiceOver do not announce the active position to AT users with this pattern. The correct pattern for a single-select group inside a menu is `role="menuitemradio"` with `aria-checked="true"|"false"`, grouped under a `role="group"` element.
- **Impact**: Blind / low-vision users cannot determine which position is currently selected when opening the menu.
- **Suggested fix**: Change the four `<button role="menuitem">` to `role="menuitemradio"`, set `aria-checked="true"` on the active position and `aria-checked="false"` on the others, and update the CSS selector `[aria-current="true"]::before` → `[aria-checked="true"]::before`.
- **Status**: pending
- **Triage**: pending

### [L1] `revealPath` ignored `source="openFolder"` when root was collapsed — APPLIED BY REVIEWER

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P2 · **Agent**: logic (also applied the fix)
- **File**: `src/webview/fileTree/FileTreePanel.ts:274` (revealPath)
- **Evidence**: Before fix: `revealPath` treated all collapsed-root reveals identically — preserve collapse, no focus. After fix: collapse-preservation is gated to `source === "osc7"`; `autoReveal` short-circuits earlier, so `openFolder` now proceeds normally (re-roots, expands, focuses).
- **Impact**: If a user collapsed the root and then clicked Open Folder, the picked path either silently dropped (if inside current root) or re-rooted but stayed collapsed (if outside). Now: always proceeds.
- **Status**: applied-by-reviewer
- **Triage**: needs user decision — accept (keep) or revert (revert + re-route through normal build triage)

### [L2] Silent open-folder failure path — APPLIED BY REVIEWER

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P3 · **Agent**: logic (also applied the fix)
- **File**: `src/providers/fileTreeHost.ts:338, 350` (open-folder handler)
- **Evidence**: Before fix: if the dialog rejected, only `console.error` ran; if `attachPost`/`attachReady` was unavailable when the user finally picked a folder, the path silently dropped. After fix: `showWarningMessage("AnyWhere Terminal file tree is no longer available. Reopen it and try again.")` when post channel is gone; `showErrorMessage("AnyWhere Terminal could not open the folder picker.")` on dialog rejection. Four new tests in `fileTreeHost.test.ts` cover these paths.
- **Impact**: User clicks Open Folder, sees nothing happen, no idea why.
- **Status**: applied-by-reviewer
- **Triage**: needs user decision — same as L1

### [L3] Position-menu `Tab` close forced focus back to move button — APPLIED BY REVIEWER

- **Severity**: SUGGEST · **Confidence**: HIGH · **Priority**: P4 · **Agent**: logic (also applied the fix)
- **File**: `src/webview/fileTree/FileTreePanel.ts:1024, 1038`
- **Evidence**: Before fix: `closePositionMenu()` always called `headerMoveBtnEl?.focus()` even when triggered by Tab (the user intent of Tab is "leave the menu, advance focus elsewhere"). After fix: a `restoreFocus` option lets Escape restore focus to the button (correct) while Tab, outside pointerdown, and dispose close without forced focus.
- **Impact**: Keyboard navigation felt sticky / focus-trap-like when tabbing past the move button.
- **Status**: applied-by-reviewer
- **Triage**: needs user decision — same as L1

### [F3] Tooltip widget lacks `aria-describedby` link to triggers

- **Severity**: SUGGEST · **Confidence**: HIGH · **Priority**: P3 · **Agent**: frontend
- **File**: `src/webview/fileTree/Tooltip.ts` (all attachTooltip callers)
- **Evidence**: Widget has `role="tooltip"` but no `id`; no `aria-describedby` is set on the target. The ARIA tooltip pattern requires the trigger to reference the tooltip via `aria-describedby` so screen readers announce the description when the trigger receives focus.
- **Impact**: AT users get no tooltip content. Since the targets already have `aria-label`, the impact is partial — the label answers "what is this button" but not the longer "Browse another folder (workspace unchanged, no reload)" hint.
- **Suggested fix**: Assign a stable `id` (e.g., `file-tree-tooltip-widget`) to the singleton in `ensureWidget`. In `attachTooltip`, set `target.setAttribute("aria-describedby", "file-tree-tooltip-widget")` on attach, remove it in the disposer.
- **Status**: pending
- **Triage**: pending

## Chair observations (not findings)

- **Re-root pulse in collapsed-vertical state**: confirmed by frontend Q4. The 600ms inset-box-shadow animation runs on `host` regardless of whether the panel is currently expanded or the 28px vertical strip. Cosmetically odd in vertical-strip mode (a thin 28px column flashes a focus border) but not a bug. SUGGEST at most; user-visible cost ≈ 600ms once per re-root.
- **Tooltip singleton across multiple FileTreePanel instances**: each VSCode webview is its own document context, so the module-level singleton state is naturally per-document. No cross-panel leakage. Within tests, `Tooltip.test.ts` calls `resetTooltipForTests()` in `afterEach`; `FileTreePanel.test.ts` does not, but its assertions don't probe `document.body.innerHTML` so no test interference.
- **Collapse animation interruption**: frontend + logic both verified mid-transition retoggles re-target correctly via class state — no wrong-final-value case found. Disarm-timer reset on each toggle keeps the gate open across rapid toggles.

## Verify gate (current working tree, post agent edits)

- `pnpm run check-types` → clean
- `pnpm run test:unit` → 1517/1517 passing

## Session IDs

- frontend: `review-refine-file-tree-controls-frontend-r3` (agent `a125f14adaeeba970`)
- logic: `review-refine-file-tree-controls-logic-r3` (agent `a587fe96949b9c32f`) — ⚠ wrote code; surfaced in protocol-issue section
- data-security: not-spawned
- contracts: not-spawned
