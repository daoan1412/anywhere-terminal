# file-tree-drag-to-terminal Specification
## Requirements

### Requirement: Custom drag MIME type for file-tree-originated drops

The system SHALL define and use the custom DataTransfer MIME type `application/x-anywhere-terminal-file-tree-path` for drag operations originating from the file tree. Each draggable tree row SHALL, on `dragstart`, set `dataTransfer.setData('application/x-anywhere-terminal-file-tree-path', <absolute-path>)`. The system MAY additionally set `text/plain` (raw path) and `text/uri-list` (URI-encoded `file://` URL), but the custom MIME is the authoritative signal for in-webview origin.

### Requirement: Drop into terminal pane inserts path without Shift

The system SHALL accept drops carrying `application/x-anywhere-terminal-file-tree-path` on any terminal pane (leaf in the split tree) WITHOUT requiring the Shift modifier — the existing OS-file-drag Shift requirement applies only when the custom MIME is absent. The dropped path SHALL be inserted at the current cursor position of the focused terminal of the targeted pane.

#### Scenario: OS file drag from VS Code Explorer is unchanged

- **WHEN** a drag from outside the webview (e.g. VS Code Explorer) lacks `application/x-anywhere-terminal-file-tree-path`
- **THEN** the existing Shift-required, active-pane-targeting behavior SHALL apply unchanged

### Requirement: Drop targets the pane under the drop point

The system SHALL identify the destination terminal pane by hit-testing the drop coordinates against the rendered leaf DOM nodes of the split tree. If the drop point lies inside multiple overlapping leaves, the topmost (last-painted) leaf wins. If the drop point lies outside any leaf, the active pane SHALL be used as a fallback.

### Requirement: Path with spaces

#### Scenario: Quoting

- **WHEN** the dropped path contains spaces, single quotes, or other shell metacharacters
- **THEN** the path SHALL be inserted using the existing `escapePathForShell` helper (the same one used by the existing OS-file drag handler) so that the resulting shell command line is correct

### Requirement: No internal reorder

The system SHALL NOT accept drops back into the file tree itself in this change; internal drag-drop (reorder / move) is explicitly out of scope. The tree container's `dragover` handler SHALL only allow the drag effect when the drop target is outside the tree's bounding box.

