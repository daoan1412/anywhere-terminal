## ADDED Requirements

### Requirement: Host-owned active file-tree root

The extension host SHALL track a per-webview `activeFileTreeRoot: string | null` for file-tree action validation and relative-path calculation. It SHALL initialize to the first VS Code workspace root, reset to the first VS Code workspace root on `workspace-root-changed`, and update to the folder path selected by the host-owned `request-open-folder` dialog before posting `reveal-in-file-tree` with `source: "openFolder"`. The webview SHALL NOT be able to set this root directly.

#### Scenario: Open Folder root outside workspace

- **WHEN** the user selects an out-of-workspace folder through the host-owned Open Folder dialog
- **THEN** file-tree actions for rows inside that selected folder SHALL validate against the selected folder, not against the VS Code workspace root.
