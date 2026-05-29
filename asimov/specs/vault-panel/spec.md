# vault-panel Specification
## Requirements

### Requirement: Searchable vault panel

The system SHALL present the aggregated session list in a webview panel (composed like the existing file-tree panel). Each row SHALL show the agent (badge/name), the title preview, the `cwd`, a relative timestamp, and resume + fork actions (fork shown only when supported for that entry).

### Requirement: In-panel client-side search

The panel SHALL provide a search box that filters the visible list by matching the typed query against the entry's title, cwd, and agent. Filtering SHALL be client-side over the already-loaded list (no per-keystroke host round-trip).

### Requirement: Open command

The system SHALL register a command that opens (expands) and focuses the vault section.

### Requirement: Stacked collapsible vault section

The vault SHALL be a persistent collapsible section stacked directly above the file tree in a shared sidebar region; both SHALL be visible at the same time (no panel exclusivity). The vault SHALL collapse to a header strip and expand to share the region with the file tree, toggled by its own header control AND a button in the file-tree header toolbar. The collapsed/expanded state SHALL persist across reloads, defaulting to collapsed. Collapsing or expanding the vault SHALL NOT disturb the file tree's own state (position/size/expansion).

#### Scenario: Toggling the vault leaves the file tree intact

- **WHEN** the file tree is visible (with a chosen position/size) and the user expands the vault via the header toolbar button
- **THEN** the vault section opens directly above the file tree (both visible), the file tree keeps its position/size, and the expanded state is persisted so a reload restores it

### Requirement: Active-folder scope filter

The vault SHALL provide a "This folder only" toggle that, when enabled, scopes the visible list to sessions whose cwd equals or is within the active terminal pane's working directory. The toggle state SHALL persist across reloads (default off). The scope SHALL update when the user selects a different pane or switches tabs. When enabled with no resolvable active-pane cwd, the vault SHALL fall back to showing all sessions. Additionally, the vault SHALL re-read its list whenever it becomes visible (expand/open) and whenever the active pane changes while expanded, since the agents' on-disk files are the source of truth.

#### Scenario: Folder scope follows the focused pane

- **WHEN** "This folder only" is enabled and the user focuses a terminal pane whose cwd is `/work/repo`
- **THEN** the vault lists only sessions whose cwd is `/work/repo` or a subdirectory of it, and re-scopes when a pane with a different cwd is focused

### Requirement: Refresh on open

The panel SHALL re-request the session index from the host each time it is opened/focused, since the agents' on-disk files are the source of truth; the host SHALL hold no index cache beyond serving the current request.

### Requirement: Empty and partial-failure states

WHEN the aggregated index is empty, the panel SHALL render an empty-state message. WHEN the index reports N unreadable entries, the panel SHALL show a non-blocking notice with the count without hiding the entries that did load.

