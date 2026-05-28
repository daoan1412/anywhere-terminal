# Tasks: refine-file-tree-controls

## 1. Webview UI

- [x] 1_1 Remove Close button; add Open Folder button in `FileTreePanel.mountHeader()`
  - **Deps**: none
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-header-open-folder-button`, `specs/file-tree-panel/spec.md#requirement-header-search-button`
  - **Scope**:
    - `src/webview/fileTree/FileTreePanel.ts`
    - `src/webview/fileTree/FileTreePanel.test.ts` (scope-extended at build time: local `AnyMsg` union mirrors `FileTreePostMessage`; adding the new request type forces this fixture to extend)
  - **Acceptance**:
    - Outcome: Header actions cluster contains exactly three buttons in DOM order `search → open-folder → move`. The Close (X) button is absent. The Open Folder button's click handler posts `{ type: "request-open-folder" }` via `this.deps.postMessage`. The button uses the codicon `folder-opened` SVG glyph (inline `<svg>`, CSP-safe pattern matching the existing search/move buttons in `mountHeader`).
    - Verify: manual — Run extension dev host (`pnpm run package` + reload window), open the AnyWhere Terminal view, confirm the X is gone and an Open Folder icon sits between search and move.
  - **Plan**:
    1. Delete the `closeBtn` block at `FileTreePanel.ts:805-809` (the `makeHeaderButton` call with label "Close File Tree") and its `actions.appendChild(closeBtn)` at line 822.
    2. Add an `openFolderBtn` block immediately AFTER the `searchBtn` block (around line 803). Use `makeHeaderButton` with `label: "Open Folder"`, an inline codicon-style `<svg>` for `folder-opened`, and `onClick: () => this.deps.postMessage({ type: "request-open-folder" })`.
    3. Update the appendChild order at lines 820-822 to: `actions.appendChild(searchBtn); actions.appendChild(openFolderBtn); actions.appendChild(moveBtn);`.
    4. Update the inline ordering comment at line 818-819 from "search → move → close" to "search → open-folder → move".

- [x] 1_2 Add always-visible bottom-position divider in `fileTreePanel.css`
  - **Deps**: none
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-bottom-position-visible-divider`
  - **Scope**:
    - `src/webview/fileTree/fileTreePanel.css`
  - **Acceptance**:
    - Outcome: When `.webview-layout.file-tree--bottom .file-tree-panel` is present, the panel renders a 1px solid border on its top edge using `var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35)))`. The border SHALL NOT be applied for the top, left, or right position classes.
    - Verify: manual — Move file tree to Bottom via the move button; confirm a horizontal line separates the terminal from the panel in default Dark+, Light+, and High Contrast themes.
  - **Plan**:
    1. Inside the existing bottom-position block at `fileTreePanel.css:594-597` (`.webview-layout.file-tree--bottom .file-tree-panel`), append `border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));`.
    2. Do not modify the `.webview-layout.file-tree--top/left/right` blocks.

## 2. Extension Host

- [x] 2_1 Handle `request-open-folder` in `FileTreeHost`
  - **Deps**: 1_1
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-open-folder-message-handler`
  - **Scope**:
    - `src/providers/fileTreeHost.ts`
    - `src/providers/fileTreeHost.test.ts`
    - `src/providers/TerminalViewProvider.ts`
    - `src/providers/TerminalEditorProvider.ts`
    - `src/types/messages.ts` (`RequestSetFileTreePositionMessage` lives near lines 263-271 — add the new type alongside it)
  - **Acceptance**:
    - Outcome: When the webview posts `{ type: "request-open-folder" }`, the inbound provider switch-case delegates to `FileTreeHost.handleMessage`, which invokes `vscode.commands.executeCommand("vscode.openFolder")` exactly once with no arguments. No reply message is posted. The new message type is included in the inbound discriminated union in `src/types/messages.ts`. A unit test in `fileTreeHost.test.ts` asserts the handler calls `executeCommand` once and posts no reply.
    - Verify: unit `src/providers/fileTreeHost.test.ts` (runs via `pnpm run test:unit`); manual — Click the Open Folder button; observe VS Code's standard Open Folder dialog appears. Cancelling the dialog leaves the workspace unchanged.
  - **Plan**:
    1. In `src/types/messages.ts`, add a new `RequestOpenFolderMessage` discriminator next to `RequestSetFileTreePositionMessage` (lines 263-271). Include it in the inbound webview-to-extension union the same way.
    2. In `FileTreeHost.handleMessage` (around the existing position-quickpick handler in `src/providers/fileTreeHost.ts`), add a case `"request-open-folder"` that calls `void vscode.commands.executeCommand("vscode.openFolder")` and returns `true`.
    3. Add `"request-open-folder"` to the fall-through case list in `TerminalViewProvider.ts:531-540` and the equivalent dispatcher in `TerminalEditorProvider.ts` so the message is routed to `fileTreeHost.handleMessage`.
    4. In `fileTreeHost.test.ts`, add a test: mock `vscode.commands.executeCommand`, call `host.handleMessage({ type: "request-open-folder" }, postFn)`, assert `executeCommand` was called once with `"vscode.openFolder"` and `postFn` was NOT called.

- [x] 2_2 Remove Toggle commands, handlers, title-bar menu entries, and command-palette suppression entries
  - **Deps**: none
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-toggle-command`, `specs/file-tree-panel/spec.md#requirement-title-bar-buttons`
  - **Scope**:
    - `package.json`
    - `src/extension.ts`
  - **Acceptance**:
    - Outcome: `package.json` no longer declares `anywhereTerminal.toggleFileTree`, `.toggleFileTree.sidebar`, or `.toggleFileTree.panel` under `contributes.commands`; the corresponding `view/title` menu entries are removed; AND the orphan `commandPalette` suppression entries (`"when": "false"`) for the per-loc commands are removed. `src/extension.ts` no longer registers handlers for any of the three commands. Building (`pnpm run check-types`) succeeds with no references to the removed command IDs anywhere in the repo (`rg "anywhereTerminal\\.toggleFileTree"` returns nothing).
    - Verify: unit `pnpm run test:unit` (existing suite must still pass); manual — confirm the Toggle list-tree icon is gone from the AnyWhere Terminal view's title bar (both sidebar and panel), and the commands no longer appear under "AnyWhere Terminal: Toggle…" in the command palette.
  - **Plan**:
    1. In `package.json`, delete the three command declarations at lines 308-322 (`anywhereTerminal.toggleFileTree`, `.toggleFileTree.sidebar`, `.toggleFileTree.panel`).
    2. In `package.json`, delete the two `view/title` menu entries at lines 396-405 binding `toggleFileTree.sidebar` and `.panel`.
    3. In `package.json`, delete the two `commandPalette` suppression entries at lines 526-533 (`.toggleFileTree.sidebar`/`.panel` with `"when": "false"`).
    4. In `src/extension.ts`, delete the `registerCommand("anywhereTerminal.toggleFileTree", ...)` block at lines 337-342.
    5. In `src/extension.ts`, delete the `registerCommand(\`anywhereTerminal.toggleFileTree.${loc}\`, ...)` block inside the per-loc loop at lines 396-400.
    6. Run `rg "toggleFileTree" -- :^asimov/` and confirm zero matches outside the spec deltas. Run `pnpm run check-types` and `pnpm run lint` to confirm no dangling references.

## 5. Collapsed-Vertical Strip (scope addition 2026-05-28)

- [x] 5_1 When position=left|right + root-collapsed, render panel as a 28px vertical strip with rotated header
  - **Deps**: 1_2
  - **Refs**: existing `.file-tree--root-collapsed` behavior in `fileTreePanel.css`
  - **Scope**:
    - `src/webview/fileTree/fileTreePanel.css`
  - **Acceptance**:
    - Outcome: When `.file-tree--root-collapsed` is combined with `.file-tree--left` or `.file-tree--right`, the panel shrinks to `flex: 0 0 28px` (was 240px). The header fills the strip vertically (flex-direction column, full height); action buttons (search/open-folder/move) are hidden; the root row uses `writing-mode: vertical-rl` so folder name + chevron read top-to-bottom. A 1px border-{left|right} replaces the hidden sash divider so the boundary with the terminal stays visible. Clicking anywhere on the strip toggles root expansion (existing rootRow click handler — unmodified).
    - Verify: manual — set file tree to Right position, collapse via root chevron → panel becomes thin vertical strip with name reading top-down; click anywhere → expands back. Repeat for Left position.
  - **Plan**:
    1. Update the comment block above the existing top/bottom collapsed rule in `fileTreePanel.css:773-779` to remove the "left/right keeps its width" line.
    2. Add new rule blocks for `.file-tree--{left,right}.file-tree--root-collapsed .file-tree-panel` setting `flex: 0 0 28px` and adding a 1px border on the terminal-facing edge.
    3. Add header rules: `flex-direction: column`, hide actions, root row gets `writing-mode: vertical-rl` + `text-orientation: mixed` + padding tweak.

## 4. In-Panel Position Menu (scope addition 2026-05-28)

- [x] 4_1 Replace move-button QuickPick roundtrip with in-panel dropdown
  - **Deps**: 1_1
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-in-panel-position-menu`
  - **Scope**:
    - `src/webview/fileTree/FileTreePanel.ts`
    - `src/webview/fileTree/fileTreePanel.css`
    - `src/webview/fileTree/FileTreePanel.test.ts`
  - **Acceptance**:
    - Outcome: Clicking the move button opens a `<div role="menu">` anchored just below the button containing four `role="menuitem"` buttons labeled Top/Bottom/Left/Right. Clicking an item calls `this.setPosition(value)` and closes the menu. The menu closes on Escape, click-outside, button re-click, or focus moving outside. ArrowUp/ArrowDown navigate items (wrap-around); Enter activates focused item; Home/End jump to first/last. The button has `aria-haspopup="menu"` and toggles `aria-expanded` between true/false. No `request-set-file-tree-position` message is posted.
    - Verify: unit `src/webview/fileTree/FileTreePanel.test.ts` (new test: opening menu, selecting item, ESC closes); manual — click move button → see 4 items inline → click one → panel moves and menu closes.
  - **Plan**:
    1. In `FileTreePanel.ts mountHeader()`, change the `moveBtn` `onClick` from `postMessage({type:"request-set-file-tree-position"})` to a new method `this.togglePositionMenu()`. Add `aria-haspopup="menu"` to the button via a new `makeHeaderButton` `aria` option (or set after construction).
    2. Add fields: `private positionMenuEl: HTMLElement | null = null;` and `private positionMenuOpen = false;`.
    3. Add `togglePositionMenu()` — calls `openPositionMenu()` / `closePositionMenu()` based on `positionMenuOpen`.
    4. Add `openPositionMenu()` — creates a `<div role="menu">` with 4 `<button role="menuitem">` children, anchors it via `position: absolute` below the move button (compute `getBoundingClientRect()` of the button relative to the header). Append to the header so the popup stays inside the panel and clips correctly. Install document-level pointerdown handler that closes the menu when the event target is outside both button and menu. Install document-level keydown handler for Escape/ArrowDown/ArrowUp/Home/End/Enter. Focus the first item.
    5. Add `closePositionMenu()` — removes the menu DOM, clears handlers, sets `positionMenuOpen=false`, returns focus to the move button via stored ref, updates `aria-expanded`.
    6. Item click handler — calls `this.setPosition(value)` then `closePositionMenu()`.
    7. In `dispose()`, ensure `closePositionMenu()` runs to clean up handlers.
    8. Add a unit test in `FileTreePanel.test.ts`: mount panel, click move button, assert menu has 4 items, click item "Right", assert position changes and menu unmounts, no postMessage called for the new IPC type.
    9. Add CSS for `.file-tree-position-menu` (positioned absolute, list-of-buttons styling, focus ring, theme vars).

- [x] 4_2 Remove dead `request-set-file-tree-position` IPC plumbing
  - **Deps**: 4_1
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-in-panel-position-menu`
  - **Scope**:
    - `src/types/messages.ts`
    - `src/providers/fileTreeHost.ts`
    - `src/providers/fileTreeHost.test.ts`
    - `src/providers/TerminalViewProvider.ts`
    - `src/providers/TerminalEditorProvider.ts`
    - `src/webview/fileTree/FileTreePanel.ts`
    - `src/webview/fileTree/FileTreePanel.test.ts`
  - **Acceptance**:
    - Outcome: `RequestSetFileTreePositionMessage` type and its entry in `WebViewToExtensionMessage` are removed from `src/types/messages.ts`. `FileTreeHost.handleMessage` no longer has a case `"request-set-file-tree-position"`. The fall-through case lists in both `TerminalViewProvider.ts` and `TerminalEditorProvider.ts` drop `"request-set-file-tree-position"`. `FileTreePostMessage` union in `FileTreePanel.ts` drops `RequestSetFileTreePositionMessage`. Local `AnyMsg` fixture in `FileTreePanel.test.ts` drops it. `grep -rn "request-set-file-tree-position" src/` returns zero matches. Command-palette `anywhereTerminal.setFileTreePosition` remains untouched and continues to use its own `vscode.window.showQuickPick`.
    - Verify: unit `pnpm run test:unit` (1500+ tests still pass); `pnpm run check-types` clean.
  - **Plan**:
    1. Remove the `RequestSetFileTreePositionMessage` interface + comment block from `src/types/messages.ts` (~lines 263-271) and its union entry (~line 359).
    2. Remove the case `"request-set-file-tree-position":` block from `FileTreeHost.handleMessage` (~lines 318-335 in fileTreeHost.ts) — keep all other cases.
    3. Remove `"request-set-file-tree-position"` from the fall-through case list in `TerminalViewProvider.ts:531-540` and `TerminalEditorProvider.ts:528-538`.
    4. Remove `RequestSetFileTreePositionMessage` from `FileTreePostMessage` union in `FileTreePanel.ts:49-58` and its import line.
    5. Remove from `AnyMsg` in `FileTreePanel.test.ts:45-52` and its import.
    6. If `fileTreeHost.test.ts` has any test exercising the removed case, drop or update it.
    7. Run `grep -rn "request-set-file-tree-position\|RequestSetFileTreePosition" src/` to confirm zero matches.

## 3. State Schema

- [x] 3_1 Drop `open: boolean` from `FileTreeState`; remove toggle-file-tree wiring; panel always renders
  - **Deps**: 1_1, 2_2
  - **Refs**: `specs/file-tree-panel/spec.md#requirement-state-persistence-schema`, `specs/file-tree-panel/spec.md#requirement-toggle-command`
  - **Scope**:
    - `src/webview/state/WebviewState.ts`
    - `src/webview/state/WebviewStateStore.ts`
    - `src/webview/state/WebviewStateStore.test.ts`
    - `src/webview/state/WebviewStateStore.searchMode.test.ts`
    - `src/webview/fileTree/FileTreePanel.ts`
    - `src/webview/fileTree/FileTreeController.ts`
    - `src/webview/messaging/MessageRouter.ts`
    - `src/webview/messaging/MessageRouter.test.ts` (scope-extended at build time: handler-shape mock requires field removal)
    - `src/webview/integration/webviewFlows.test.ts` (scope-extended at build time: handler-shape mock requires field removal)
    - `src/webview/main.ts`
    - `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: `FileTreeState.open` is removed from the TypeScript interface. The webview never reads or writes a boolean for "open"; `panel.setOpen()` and `FileTreeController.handleToggle()` are deleted; `MessageHandlers.onToggleFileTree` and the `"toggle-file-tree"` dispatch case in `MessageRouter` are deleted; `ToggleFileTreeMessage` is removed from `src/types/messages.ts` and from the `ExtensionToWebViewMessage` union. The outbound message is no longer posted by the extension host (already handled by task 2_2). Existing persisted state objects containing `open: true|false` continue to restore cleanly (the field is silently dropped). `pnpm run check-types` succeeds with no `Property 'open' does not exist` or unused-handler errors. All unit tests in `WebviewStateStore.test.ts` and `WebviewStateStore.searchMode.test.ts` pass after updating fixture FileTreeState literals to drop `open`.
    - Verify: unit `src/webview/state/WebviewStateStore.test.ts` and `src/webview/state/WebviewStateStore.searchMode.test.ts` (runs via `pnpm run test:unit`)
  - **Plan**:
    1. Remove the `open: boolean` field (and its JSDoc) from `FileTreeState` in `src/webview/state/WebviewState.ts:15-38`.
    2. In `WebviewStateStore.ts`, remove any `open` reads/writes; ensure migration from the legacy `fileTree` slot silently drops the field.
    3. Update fixtures in `WebviewStateStore.test.ts` (all `open:` references) and in `WebviewStateStore.searchMode.test.ts` (lines 27, 43, 55-56) — delete the property; tests should still pass on the remaining fields.
    4. In `FileTreePanel.ts`, delete the `setOpen` method (its only caller was the removed Close button), any internal `open` boolean state field, and the persistence write that includes it. The panel always renders.
    5. In `src/webview/fileTree/FileTreeController.ts`, delete the `panel.setOpen(...)` call at lines 130-136 (and the surrounding `persisted.open` read), and delete `handleToggle()` at lines 169-171.
    6. In `src/webview/messaging/MessageRouter.ts`, delete the `onToggleFileTree` field from `MessageHandlers` (line 74) and the corresponding `"toggle-file-tree"` dispatch case (lines 170-171). Update any handler-shape tests.
    7. In `src/webview/main.ts` (around `:415-417`), remove the `onToggleFileTree` wiring that used to forward to `FileTreeController.handleToggle()`.
    8. In `src/types/messages.ts`, delete `ToggleFileTreeMessage` (lines 704-707) and remove it from the `ExtensionToWebViewMessage` union (line 821).
    9. Run `pnpm run check-types`, `pnpm run lint`, and `pnpm run test:unit` to confirm everything still compiles and passes.
