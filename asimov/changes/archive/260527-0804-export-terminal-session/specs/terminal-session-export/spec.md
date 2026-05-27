## ADDED Requirements

### Requirement: Export Buffer command

The system SHALL register a command `anywhereTerminal.exportBuffer` titled `AnyWhere Terminal: Export Buffer to File…` that resolves the currently focused terminal session, requests its full scrollback via `SessionManager.requestScrollbackDump`, opens `vscode.window.showSaveDialog`, and writes the chosen file. The command SHALL be enabled whenever at least one AnyWhere Terminal session exists.

#### Scenario: No focused session

- **WHEN** the command is invoked while no AnyWhere Terminal session is focused
- **THEN** the system MUST show a warning toast with exact text `"AnyWhere Terminal: focus a terminal session before exporting."` and MUST NOT open the save dialog.

### Requirement: Export Last Command Output command

The system SHALL register a command `anywhereTerminal.exportLastCommand` titled `AnyWhere Terminal: Export Last Command Output…` that retrieves `SessionManager.getLastCompletedCommand(sessionId)` for the focused session and writes the command-line, exit code, and output to the chosen file. The file content layout SHALL be:

```
$ <commandLine>
[exit <exitCode>] [cwd <cwd>]

<output>
```

#### Scenario: No tracked commands available

- **WHEN** `getLastCompletedCommand` returns `null` (shell integration not active for this terminal, OR no command completed yet since the last window reload)
- **THEN** the system MUST show an info toast with exact text `"AnyWhere Terminal: no tracked commands yet. Commands track from window reload onward and require shell integration — see Help."` containing a `Help` button that opens the relevant README anchor, and MUST NOT open the save dialog.

### Requirement: Export Command picker

The system SHALL register a command `anywhereTerminal.exportCommand` titled `AnyWhere Terminal: Export Command…` that opens `vscode.window.showQuickPick` listing `getTrackedCommands(sessionId)` for the focused session in most-recent-first order. Each pick item label SHALL be the truncated command-line (≤80 chars, ellipsis suffix on truncation) and the detail SHALL show `exit <exitCode> · <cwd> · <relative-time>`. The selected command SHALL be written using the same layout as `exportLastCommand`.

#### Scenario: Picker shown with empty list

- **WHEN** the picker would be opened but the tracked-commands list is empty
- **THEN** the system MUST fall back to the same info toast as `exportLastCommand` (do not open an empty picker).

### Requirement: ANSI stripping by default with raw-preserved option

The system SHALL strip ANSI escape codes from all written output by default via the project's ANSI-stripping utility (concrete package + version pinned in `design.md` D7). The `showSaveDialog` filter list SHALL offer two options: `"Text (ANSI stripped)"` extensions `["txt", "log"]` (default) and `"Raw (ANSI preserved)"` extensions `["log", "ansi"]`. The default filename SHALL be `<sanitized-session-name>-<YYYYMMDD-HHmmss>.txt` where the session name has `[^A-Za-z0-9._-]` replaced with `_` and the timestamp is local time of save invocation. The file content SHALL be written as UTF-8 via the VS Code workspace filesystem API (concrete mechanism in `design.md` D8).

#### Scenario: Write failure

- **WHEN** the workspace filesystem write throws (permission denied, read-only volume, etc.)
- **THEN** the system MUST surface an error toast with exact text `"AnyWhere Terminal: failed to write <path> — <reason>."` where `<reason>` is the error `message`. The export MUST NOT leave a partial file: writes go to a `.tmp` sibling first then atomic rename (mechanism in `design.md` D8).
