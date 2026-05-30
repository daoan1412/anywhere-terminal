## MODIFIED Requirements

### Requirement: settings-schema

The extension SHALL define a `contributes.configuration` section in `package.json` with the following settings:

- `anywhereTerminal.shell.macOS` (string, default `""`) — Custom shell path for macOS. Empty string means auto-detect.
- `anywhereTerminal.shell.linux` (string, default `""`) — Custom shell path for Linux. Empty string means auto-detect.
- `anywhereTerminal.shell.windows` (string, default `""`) — Custom shell path for Windows. Empty string means auto-detect.
- `anywhereTerminal.shell.args` (array of strings, default `[]`) — Custom shell arguments. Empty array means use defaults.
- `anywhereTerminal.scrollback` (number, default `10000`) — Maximum scrollback buffer lines.
- `anywhereTerminal.fontSize` (number, default `0`) — Font size in pixels. 0 means inherit from VS Code.
- `anywhereTerminal.fontFamily` (string, default `""`) — Font family. Empty string means inherit from VS Code.
- `anywhereTerminal.cursorBlink` (boolean, default `true`) — Whether the cursor blinks.
- `anywhereTerminal.defaultCwd` (string, default `""`) — Default working directory. Empty string means workspace root or home.

The three `shell.<platform>` keys SHALL use `"scope": "machine"`, consistent with `shell.macOS` and `shell.args`.

### Requirement: settings-reader

The extension host SHALL provide a `readTerminalSettings()` function that reads all `anywhereTerminal.*` settings via `workspace.getConfiguration('anywhereTerminal')` and returns a resolved configuration object.

- Font size resolution chain: `anywhereTerminal.fontSize` (if >0) → `terminal.integrated.fontSize` (if >0) → `editor.fontSize` (if >0) → 14
- Font size MUST be clamped to range [6, 100]
- Font family resolution chain: `anywhereTerminal.fontFamily` (if non-empty) → `terminal.integrated.fontFamily` (if non-empty) → `editor.fontFamily` (if non-empty) → `'monospace'`
- Shell resolution SHALL select the per-platform setting key matching `process.platform` — `shell.windows` on `win32`, `shell.linux` on `linux`, otherwise `shell.macOS` — and use it (if non-empty) → otherwise auto-detect via `PtyManager.detectShell()`.
- CWD resolution: `anywhereTerminal.defaultCwd` (if non-empty and valid directory) → workspace root → home directory

#### Scenario: Shell key matches the running platform

- **WHEN** `process.platform` is `win32` and `anywhereTerminal.shell.windows` is `C:\\Program Files\\PowerShell\\7\\pwsh.exe`
- **THEN** `readTerminalSettings()` resolves `shell` to that path
- **AND** `anywhereTerminal.shell.macOS` is ignored
