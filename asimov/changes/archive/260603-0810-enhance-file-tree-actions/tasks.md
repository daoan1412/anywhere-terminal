## 1. Contracts

- [x] 1_1 Add file-tree path action message contracts
  - **Deps**: none
  - **Refs**: specs/file-tree-context-menu/spec.md; design.md D3; design.md D5
  - **Scope**: src/types/messages.ts
  - **Acceptance**:
    - Outcome: Webview-to-extension message unions include reveal, copy path, copy relative path, and delete file-tree action messages with path and rootGeneration payloads; no action message accepts a webview-supplied relative base path.
    - Verify: unit src/types/messages.ts
  - **Plan**:
    1. Add the four interfaces from design.md and include them in the existing webview-to-extension union.

## 2. Webview Menu

- [x] 2_1 Add file-tree context-menu helper
  - **Deps**: 1_1
  - **Refs**: specs/file-tree-context-menu/spec.md; design.md D1; docs/research/20260603-vscode-explorer-context-menu.md
  - **Scope**: src/webview/fileTree/FileTreeContextMenu.ts, src/webview/fileTree/FileTreeContextMenu.test.ts, src/webview/fileTree/fileTreePanel.css, src/webview/vault/VaultContextMenu.ts
  - **Acceptance**:
    - Outcome: A body-mounted file-tree context menu renders the required menu items in order, exposes ARIA menu roles, closes on Escape/outside click/action, and restores focus on Escape.
    - Verify: unit src/webview/fileTree/FileTreeContextMenu.test.ts
  - **Plan**:
    1. Model lifecycle and outside-click cleanup after `VaultContextMenu`.
    2. Add platform-aware reveal label selection.
    3. Style the menu with VS Code theme variables and a destructive Delete row.
    4. Emit callbacks or message-send functions for each menu action.

- [x] 2_2 Wire row right-click into the renderer
  - **Deps**: 2_1
  - **Refs**: specs/file-tree-context-menu/spec.md; design.md D2
  - **Scope**: src/webview/fileTree/ReadOnlyFileRenderer.ts, src/webview/fileTree/ReadOnlyFileRenderer.test.ts
  - **Acceptance**:
    - Outcome: Real file and folder rows forward `contextmenu` events to the panel callback, while synthetic search/error/overflow rows do not open a context menu.
    - Verify: unit src/webview/fileTree/ReadOnlyFileRenderer.test.ts
  - **Plan**:
    1. Add an optional context-menu callback to the renderer constructor/options.
    2. Store the current rendered node in template data during row binding.
    3. On `contextmenu`, prevent default and call the callback only for real filesystem nodes.

- [x] 2_3 Connect the menu from FileTreePanel
  - **Deps**: 2_2
  - **Refs**: specs/file-tree-context-menu/spec.md; design.md D1; design.md D3
  - **Scope**: src/webview/fileTree/FileTreePanel.ts, src/webview/fileTree/FileTreePanel.test.ts
  - **Acceptance**:
    - Outcome: Right-clicking a file or folder row selects it, opens the context menu without activating the row, sends the correct action messages with current rootGeneration, and does not expose a root/header context menu.
    - Verify: unit src/webview/fileTree/FileTreePanel.test.ts
  - **Plan**:
    1. Instantiate `FileTreeContextMenu` during panel setup and dispose it with the panel.
    2. Pass a renderer context-menu callback during `Tree<FileNode>` construction.
    3. On menu open, close competing panel menus and set tree selection without activating the row.
    4. Send `file-tree-*` messages through the existing file-tree/webview message channel.

## 3. Host Actions

- [x] 3_1 Implement FileTreeHost path action handlers
  - **Deps**: 1_1
  - **Refs**: specs/file-tree-context-menu/spec.md; specs/file-tree-rpc/spec.md; design.md D3; design.md D4; design.md D5; design.md D6; design.md D7; docs/research/20260603-vscode-explorer-context-menu.md
  - **Scope**: src/providers/fileTreeHost.ts, src/providers/fileTreeHost.test.ts
  - **Acceptance**:
    - Outcome: Host reveal, copy path, copy relative path, and confirmed trash delete actions execute only for current-generation paths contained under the host-owned active file-tree root; delete refreshes the parent directory on success.
    - Verify: unit src/providers/fileTreeHost.test.ts
  - **Plan**:
    1. Add host-owned `activeFileTreeRoot`, initialized/reset from workspace root and updated by confirmed Open Folder selection before posting `reveal-in-file-tree`.
    2. Add message cases for the four file-tree path actions.
    3. Add shared validation for rootGeneration and target containment under `activeFileTreeRoot`; reject delete when target equals the active root.
    4. Implement reveal with `revealFileInOS` and copy actions with `vscode.env.clipboard.writeText`; compute relative paths from `activeFileTreeRoot`.
    5. Implement delete with stat, modal confirmation, post-confirm revalidation, `workspace.fs.delete` using trash, parent invalidation, and user-visible errors for stat/delete failures.
    6. Unit-test stale generation, stale after confirmation, outside-root path, Open Folder root outside workspace, forged basePath absence, root delete rejection, cancel, stat failure, delete failure, file delete, folder delete, copy relative normalization, and reveal command invocation.

- [x] 3_2 Route new messages through both terminal providers
  - **Deps**: 3_1
  - **Refs**: specs/file-tree-context-menu/spec.md; design.md D3
  - **Scope**: src/providers/TerminalViewProvider.ts, src/providers/TerminalViewProvider.test.ts, src/providers/TerminalEditorProvider.ts, src/providers/TerminalEditorProvider.test.ts
  - **Acceptance**:
    - Outcome: Sidebar/panel webviews and editor webviews both delegate the new file-tree action messages to `FileTreeHost`.
    - Verify: unit src/providers/TerminalViewProvider.test.ts
  - **Plan**:
    1. Extend provider dispatch switches using the same delegation pattern as existing file-tree read/search/watch messages, and test all four new message types in both providers.

## 4. Verification

- [x] 4_1 Run focused verification
  - **Deps**: 2_3, 3_2
  - **Refs**: specs/file-tree-context-menu/spec.md
  - **Scope**: package.json
  - **Acceptance**:
    - Outcome: Type checking and unit tests covering file-tree context-menu behavior pass.
    - Verify: manual run `pnpm run check-types && pnpm run test:unit`
  - **Plan**:
    1. Run type check and unit tests; fix only failures caused by this change within scoped task files.
