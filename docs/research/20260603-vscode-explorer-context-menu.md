---
topic: vscode-explorer-context-menu
created-by: asimov planning for enhance-file-tree-actions
date: 2026-06-03
libraries: [vscode]
used-by: [asimov/changes/enhance-file-tree-actions]
---

# Research: VS Code Explorer Context Menu

## Source

Read-only inspection of sibling checkout `../vscode`.

## Findings

- Explorer delete and trash commands are contributed in `src/vs/workbench/contrib/files/browser/fileActions.contribution.ts`.
- Explorer context menus group path-copy actions before destructive file modifications.
- Copy Path and Copy Relative Path are implemented through command handlers that resolve the selected resources, format the path or relative path, join multiple selections with the configured separator, and write through the host clipboard service.
- Reveal in Finder/File Explorer is contributed from Electron-specific file actions and calls the native host service that maps to the platform shell "show item in folder" behavior.
- Delete uses confirmation when enabled, moves to trash by default, supports permanent delete separately, and falls back to permanent delete only after trash failure confirmation.
- Deletion operates over file edits with recursive capability for folders.

## Applicability to AnyWhere Terminal

- The file-tree webview should render a compact row context menu and route actions to the extension host.
- Clipboard actions should use `vscode.env.clipboard.writeText`, not browser clipboard APIs.
- Reveal should use VS Code's `revealFileInOS` command with `vscode.Uri.file(path)`.
- Delete should be modal-confirmed, move to trash by default, support files and folders, and refresh the affected parent directory after success.
- Menu ordering should keep non-destructive path actions together and place Delete last.

## Relevant VS Code Paths

- `../vscode/src/vs/workbench/contrib/files/browser/fileActions.contribution.ts`
- `../vscode/src/vs/workbench/contrib/files/browser/fileActions.ts`
- `../vscode/src/vs/workbench/contrib/files/browser/fileCommands.ts`
- `../vscode/src/vs/workbench/contrib/files/electron-browser/fileActions.contribution.ts`
- `../vscode/src/vs/workbench/contrib/files/electron-browser/fileCommands.ts`
