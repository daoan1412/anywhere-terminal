## ADDED Requirements

### Requirement: File tree row context menu

The system SHALL open an in-webview context menu when the user right-clicks a real file-tree row representing a file or folder. The menu SHALL contain exactly these items in order: `Reveal in Finder` on macOS and `Reveal in File Explorer` on Windows/Linux, `Copy Path`, `Copy Relative Path`, separator, `Delete`.

#### Scenario: Synthetic rows do not open a menu

- **WHEN** the user right-clicks a search overflow, search error, empty-state, loading-only, or other synthetic file-tree row without a real filesystem path
- **THEN** the system SHALL NOT open the file-tree context menu.

#### Scenario: Root header is not a row action target

- **WHEN** the user right-clicks the file-tree header/root display
- **THEN** the system SHALL NOT open the file-tree row context menu.

### Requirement: Context menu interaction semantics

The context menu SHALL use `role="menu"` and menu items SHALL use `role="menuitem"`. The menu SHALL close on Escape, click outside, selecting an item, or opening another file-tree menu. Escape SHALL restore focus to the row that opened the menu.

### Requirement: Context menu preserves tree behavior

Opening the context menu SHALL select the right-clicked row without activating it. The system SHALL preserve existing left-click file open behavior, folder expand/collapse behavior, drag-to-terminal behavior, search mode rendering, tree keyboard navigation, and panel positioning.

### Requirement: File tree path action messages

The system SHALL define typed webview-to-extension messages for file-tree path actions:

```ts
type FileTreeRevealInOsMessage = { type: "file-tree-reveal-in-os"; path: string; rootGeneration: number };
type FileTreeCopyPathMessage = { type: "file-tree-copy-path"; path: string; rootGeneration: number };
type FileTreeCopyRelativePathMessage = { type: "file-tree-copy-relative-path"; path: string; rootGeneration: number };
type FileTreeDeleteMessage = { type: "file-tree-delete"; path: string; rootGeneration: number };
```

Each `path` field SHALL be an absolute filesystem path. The webview SHALL NOT send a relative-path base; the extension host SHALL derive it from the host-owned active file-tree root.

### Requirement: Reveal in OS file manager

Selecting the reveal menu item SHALL send `file-tree-reveal-in-os` and the extension host SHALL execute VS Code's `revealFileInOS` command for the target path.

### Requirement: Copy absolute path

Selecting `Copy Path` SHALL send `file-tree-copy-path` and the extension host SHALL write the absolute target path to `vscode.env.clipboard`.

### Requirement: Copy relative path

Selecting `Copy Relative Path` SHALL send `file-tree-copy-relative-path` and the extension host SHALL write `path.relative(activeFileTreeRoot, path)` to `vscode.env.clipboard`, normalized to forward-slash separators on all platforms.

### Requirement: Delete confirmation

Selecting `Delete` SHALL send `file-tree-delete` and the extension host SHALL stat the target before prompting. If the target is a file, the modal warning message SHALL be `Delete "<basename>"?` with detail `The item at <absolute path> will be moved to the trash.` If the target is a folder, the modal warning message SHALL be `Delete folder "<basename>"?` with detail `The folder and its contents at <absolute path> will be moved to the trash.` The confirmation primary action text SHALL be `Delete`; cancelling, closing, or choosing any other action SHALL NOT delete the target.

### Requirement: Delete moves target to trash

After delete confirmation, the extension host SHALL re-check rootGeneration and active-root containment, then delete the target using `vscode.workspace.fs.delete(vscode.Uri.file(path), { recursive: <is-directory>, useTrash: true })`. Folder targets SHALL be deleted recursively only after the same confirmation flow. The host SHALL reject targets that are neither files nor directories and SHALL surface stat or delete failures as user-visible error messages.

### Requirement: Root generation and path validation for actions

The extension host SHALL reject file-tree path actions when `rootGeneration` does not match the current host-side file-tree generation. The host SHALL also reject a target path that is not equal to or inside the host-owned active file-tree root for the webview. For `file-tree-delete`, the host SHALL additionally reject a target path equal to the active file-tree root.

### Requirement: Delete refreshes parent directory

After a successful delete, the extension host SHALL post `fs-changes-invalidated` for the deleted target's parent directory using the current `rootGeneration` so the webview refreshes the affected tree branch.
