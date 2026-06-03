# Proposal: enhance-file-tree-actions

## Why

The file tree currently exposes open, search, drag, and positioning behavior, but rows do not offer common file actions. Users need a VS Code-like row context menu for revealing, copying paths, and deleting files or folders without leaving AnyWhere Terminal.

## Appetite

M (≤3d)

## Scope

### In scope

- Add a right-click context menu for real file-tree rows.
- Add menu items: Reveal in Finder/File Explorer, Copy Path, Copy Relative Path, Delete.
- Support both file and folder rows.
- Confirm Delete with a modal host dialog before moving the target to trash.
- Route reveal, copy, relative-copy, and delete actions to the extension host.
- Refresh the affected parent directory after successful delete.
- Preserve existing click-to-open, folder-toggle, search, drag-to-terminal, panel positioning, and tree keyboard behavior.
- Track the active file-tree root on the extension host so Open Folder roots outside the workspace remain valid without trusting webview-supplied base paths.

### Out of scope

- Delete Permanently as a separate menu item.
- Multi-selection context-menu actions.
- Rename, create file/folder, move, duplicate, cut, paste, or drag-reorder.
- Configuring delete confirmation or path separator settings.
- Native VS Code menu contribution integration; this is an in-webview menu.
- Showing a context menu on the file-tree root/header or deleting the active file-tree root.

## Capabilities

1. **file-tree-context-menu** — Adds a file-tree row context menu and host-side path actions for reveal, copy, relative copy, and confirmed trash delete.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES
- **E2E required?** NOT REQUIRED
- **Justification**: The behavior is contained in webview components and extension-host handlers that can be verified with unit/integration tests; no VS Code-native end-to-end automation exists in this project for file-tree context menus.

## Risk Level

MEDIUM — the change adds the first user-triggered delete action from the file tree and spans webview UI, IPC types, and extension-host filesystem behavior.
