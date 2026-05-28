# Oracle Review — refine-file-tree-controls (Round 4, user-requested)

- **Date**: 2026-05-28T07:35:00Z
- **Reviewer**: asm-oracle (`ab8d046987c2057c8`) — read-only independent second opinion
- **Scope**: verify round-3 findings + fresh full pass over change

## Verification of round-3 findings

| ID | Round-3 stance | Oracle stance | Notes |
|---|---|---|---|
| F1 | WARN (needs manual repro) | **false positive** | Native `<button>` Enter/Space dispatches `click` — doc-level keydown handler doesn't intercept Enter/Space (no `preventDefault`). Activation works. → close as rejected. |
| F2 | WARN | **confirmed real issue** | `aria-current` on `role="menuitem"` is wrong; `role="menuitemradio"` + `aria-checked` correct. Caveat: spec line 17 mandates `role="menuitem"` — spec must change with the fix. |
| F3 | SUGGEST | **valid as SUGGEST** | Not a blocker — `aria-label` covers names; long-form hints unreachable to AT. |
| L1 | applied-by-reviewer | **mostly correct** | No regression for `osc7`/`autoReveal`. Residual edge → see N6. |
| L2 | applied-by-reviewer | **correct, coverage adequate** | Only untested subcase is `attachPost === null` (same branch as `attachReady?.() === false`). |
| L3 | applied-by-reviewer | **correct** | `restoreFocus` parameter correctly threaded — Escape true, Tab/outside/dispose false. |

## Independent findings (new)

### [N1] Search-button native title returns + custom tooltip text becomes stale on enter/exit search

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P2
- **File**: `src/webview/fileTree/FileTreePanel.ts:1177` (enterSearch) and `:1216` (exitSearch)
- **Evidence**: `attachTooltip()` captures the search button's initial title ("Search files in tree") at mount-time into its closure `text`, then strips the `title` attribute (`Tooltip.ts:81-92`). But `enterSearch()` later re-sets `title="Close search"` and `exitSearch()` re-sets `title="Search files"`. Net effects:
  1. Native browser tooltip now displays the just-reassigned title (because the strip only ran once at attach).
  2. Custom tooltip (if user hovers) still shows the stale closure value "Search files in tree", regardless of search-active state.
- **Impact**: Two competing tooltips, neither correctly labels the current button state. UX confusion.
- **Suggested fix**: either (a) extend `attachTooltip` to accept a getter `() => string` so the panel can pass `() => this.searchActive ? "Close search" : "Search files in tree"`, OR (b) re-attach the tooltip on each search-state transition (cheaper but loses 300ms warm-up state), OR (c) drop the `title` reassignment and rely only on `aria-label` for the state change.

### [N2] Position menu has no vertical viewport clamp / flip

- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P3
- **File**: `src/webview/fileTree/FileTreePanel.ts:961-974` (openPositionMenu anchor math)
- **Evidence**: `top = btnRect.bottom + 2` is always set; only `left` is clamped against the viewport. In bottom-position panels or short webview viewports, the menu can extend below the visible area.
- **Impact**: User can't see all 4 items; the clipped items appear unreachable.
- **Suggested fix**: After mount, measure `menuRect.height` (already done for width), and if `top + height > viewportH - 4`, flip above the button: `top = btnRect.top - menuRect.height - 2`.

### [N3] Collapse-animation gate can leak on the wrapper after dispose

- **Severity**: SUGGEST · **Confidence**: HIGH · **Priority**: P4
- **File**: `src/webview/fileTree/FileTreePanel.ts:735-738` (dispose)
- **Evidence**: `armCollapseAnimation()` adds `.file-tree--anim` and relies on a 200ms timer to remove it (`:1319-1326`). `dispose()` clears the timer but doesn't remove the class. If a panel is disposed mid-gate while the layout wrapper survives (e.g., panel re-mount on workspace change), the next panel/sash interaction starts with animation enabled.
- **Impact**: Cosmetic — first user-initiated layout flip after a mid-armed dispose animates when it shouldn't.
- **Suggested fix**: `this.deps.layoutWrapper?.classList.remove("file-tree--anim")` in `dispose()` alongside the `clearTimeout`.

### [N4] Spec is stale — still describes `executeCommand("vscode.openFolder")`, implementation uses `showOpenDialog`

- **Severity**: SUGGEST · **Confidence**: HIGH · **Priority**: P3
- **File**: `asimov/changes/refine-file-tree-controls/specs/file-tree-panel/spec.md:7-9`
- **Evidence**: Spec mandates `request-open-folder` → `vscode.commands.executeCommand('vscode.openFolder')` (the original reload-causing flow). Implementation switched to `showOpenDialog` + reuse `reveal-in-file-tree` `source="openFolder"` (the no-reload flow user requested mid-build) at `fileTreeHost.ts:327-347`. Also spec line 17 mandates `role="menuitem"` which conflicts with the F2 fix.
- **Impact**: Future agents (or this one in a later session) could reintroduce the reload flow following the stale spec. Per asimov-build "Artifact sync" rule, behavior changes should update the spec BEFORE continuing.
- **Suggested fix**: Update `spec.md` to describe the actual implemented flow (showOpenDialog + reveal-in-file-tree) and the chosen ARIA pattern (after F2 disposition).

### [N5] Tooltip widget is mouse-only (no focus/blur path) — WCAG 1.4.13

- **Severity**: SUGGEST · **Confidence**: HIGH · **Priority**: P3
- **File**: `src/webview/fileTree/Tooltip.ts:104-107` (attachTooltip listener list)
- **Evidence**: Listeners cover `mouseenter`/`mouseleave`/`mousedown`/`keydown` (Escape). No `focus`/`blur` path. CSS `pointer-events: none` on the tooltip means hover-on-tooltip is also impossible (so users can't move the cursor onto the tooltip to keep it open). WCAG 1.4.13 Content on Hover or Focus requires keyboard focus to also trigger persistent hints.
- **Impact**: Keyboard-only users never see the extended hints; they only get the `aria-label`.
- **Suggested fix**: Add `focus` (show) and `blur` (hide) listeners alongside the mouse ones. If keeping `role="tooltip"`, pair with `aria-describedby` (overlaps with F3).

### [N6] `openFolder` selecting the current collapsed root leaves panel visually collapsed

- **Severity**: SUGGEST · **Confidence**: MEDIUM · **Priority**: P4
- **File**: `src/webview/fileTree/FileTreePanel.ts:324-355` (revealPath segments path)
- **Evidence**: After L1 fix, `openFolder` now proceeds even while collapsed. But when `absPath === workspaceRootPath` (user picks the same folder they're already in), `segments` is empty → code selects/focuses the root but never expands it. With `hideRoot: true` (`:1377-1381`), the root never shows in the body, so the panel stays visually collapsed after an explicit Open Folder action.
- **Impact**: User clicks Open Folder, picks current root → nothing visible happens (the focus pulse plays, but body stays collapsed).
- **Suggested fix**: For `source === "openFolder"` when `current === root`, explicitly expand the root before the focus step.

## Overall verdict

**WARN** — the main behaviors are structurally sound, but **N1 (tooltip stale + double-render on search toggle)** and **N2 (no vertical clamp on position menu)** are user-visible enough to fix before landing. F1 is a false positive; F2 and the four SUGGEST items can be deferred or batched with the spec sync (N4) at archive time.

## Recommended triage order

1. **N1** (WARN) — fix; user-visible tooltip bug, low effort (~10 lines).
2. **N2** (WARN) — fix; viewport clamp/flip, low effort (~5 lines).
3. **F2** (WARN) — fix if accessibility is a goal; small but spec-coupled (must also update N4).
4. **N4** (SUGGEST) — fix BEFORE archive (artifact-sync rule); decouple from F2 disposition.
5. **L1/L2/L3** — already applied; only flag for revert/keep policy decision.
6. **F3 / N3 / N5 / N6** — defer or batch as polish.
7. **F1** — close as rejected (false positive).
