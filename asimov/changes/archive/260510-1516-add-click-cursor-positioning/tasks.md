## 1. Click Cursor Positioning

- [x] 1_1 Add click cursor movement calculation and guards
  - **Deps**: none
  - **Refs**: specs/click-cursor-positioning/spec.md; docs/research/20260508-xterm-click-cursor-positioning.md; docs/research/20260508-xterm-click-cursor-conflicts.md
  - **Scope**: `src/webview/ClickCursorHandler.ts`, `src/webview/ClickCursorHandler.test.ts`
  - **Acceptance**:
    - Outcome: Unmodified primary clicks can be translated into relative ANSI cursor movement, while modified clicks, selection, drag gestures, scrolled-back viewports, alternate buffer, and active mouse tracking modes produce no input.
    - Verify: unit src/webview/ClickCursorHandler.test.ts
  - **Plan**:
    1. Define a small dependency-injected handler around terminal dimensions, buffer cursor state, selection state, container bounds, and an input callback.
    2. Convert click coordinates to clamped cell coordinates using public terminal dimensions and container bounds.
    3. Guard on normal buffer and `mouseTrackingMode === 'none'` before generating any movement.
    4. Generate relative movement sequences (`A/B/C/D`) from current cursor position to target cell, returning no input when movement is zero.
    5. Add unit tests for happy path, horizontal/vertical movement, clamping, selection guard, modifier guard, button guard, drag guard, scrollback guard, alternate-buffer guard, and mouse-tracking guards.

- [x] 1_2 Wire click cursor positioning into terminal creation
  - **Deps**: 1_1
  - **Refs**: specs/click-cursor-positioning/spec.md; docs/research/20260508-xterm-click-cursor-conflicts.md; docs/design/xterm-integration.md; docs/design/flow-user-input.md
  - **Scope**: `src/webview/terminal/TerminalFactory.ts`, `src/webview/ClickCursorHandler.ts`, `src/webview/ClickCursorHandler.test.ts`
  - **Acceptance**:
    - Outcome: Each xterm instance installs the click handler during terminal creation and emits movement through the same input callback used by normal terminal input.
    - Verify: manual click a long prompt command in sidebar and split pane; cursor moves to the clicked cell without modifier keys _(not run in headless build; covered by `pnpm run check-types` and `pnpm exec vitest run src/webview/ClickCursorHandler.test.ts`)_
  - **Plan**:
    1. Attach the handler per terminal instance after `terminal.open(container)` and before focus/resize post-create work.
    2. Reuse the existing `postMessage({ type: 'input', tabId, data })` route instead of adding message types.
    3. Ensure the handler runs after the existing split-pane focus behavior and targets the clicked terminal instance ID.
    4. Read active buffer type and mouse tracking mode from public xterm surfaces only; if private access is required, stop and re-scope.

- [x] 1_3 Update design documentation for the interaction
  - **Deps**: 1_2
  - **Refs**: specs/click-cursor-positioning/spec.md; docs/research/20260508-xterm-click-cursor-conflicts.md; docs/design/keyboard-input.md; docs/design/xterm-integration.md
  - **Scope**: `docs/design/keyboard-input.md`, `docs/design/xterm-integration.md`
  - **Acceptance**:
    - Outcome: Existing design docs describe plain click-to-cursor behavior, its guards, its app mouse-mode skip behavior, and its limitation to shell/readline-style cursor movement.
    - Verify: none — docs-only
  - **Plan**:
    1. Add a concise section covering click-to-cursor behavior, guard conditions, and the existing raw input path.
    2. Mention the known limitation for fullscreen and mouse-aware TUI applications without promising unsupported behavior.
