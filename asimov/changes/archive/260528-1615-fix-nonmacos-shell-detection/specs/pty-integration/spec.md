## MODIFIED Requirements

### Requirement: Shell Detection

The system SHALL detect the user's preferred shell using a platform-aware resolution order, returning `{ shell: string; args: string[] }`. `detectShell(platform, env, vscodeShell)` SHALL accept injectable `platform` (default `process.platform`), `env` (default `process.env`), and `vscodeShell` (default `vscode.env.shell`) parameters for testability.

Resolution order (first validated candidate wins):
1. `vscodeShell` — when non-empty (VS Code's resolved default; honors `terminal.integrated.defaultProfile` and the remote extension host).
2. Platform env hint — `env.SHELL` on non-Windows; `env.ComSpec` (or `env.COMSPEC`) on Windows.
3. Platform default chain — macOS `/bin/zsh` → `/bin/bash` → `/bin/sh`; Linux `/bin/bash` → `/bin/sh`; Windows `%ComSpec%` else `cmd.exe`.

When no candidate validates, the system SHALL return a last-resort default unconditionally — POSIX `/bin/sh` (the final chain entry), Windows `%ComSpec%` else the literal `cmd.exe` — so detection does not throw on supported platforms.

#### Scenario: Windows resolves a shell instead of throwing

- **WHEN** `platform` is `win32`, `vscodeShell` is empty, and `env.ComSpec` is `C:\Windows\System32\cmd.exe`
- **THEN** `detectShell()` returns `{ shell: 'C:\\Windows\\System32\\cmd.exe', args: [] }`
- **AND** no `ShellNotFoundError` is thrown

#### Scenario: vscode.env.shell takes priority when present

- **WHEN** `vscodeShell` is a non-empty validated path (e.g. the user's `terminal.integrated.defaultProfile` shell)
- **THEN** `detectShell()` returns that shell

## ADDED Requirements

### Requirement: Shell Validation

The system SHALL validate a shell path via `validateShell(shellPath, platform)`. On non-Windows platforms validation SHALL require the path to exist, be a file, and have an execute bit (`stat.mode & 0o111`). On Windows validation SHALL require only that the path exists and is a file — Node does not expose reliable Unix execute bits for Windows executables, so an execute-bit check would reject valid `.exe` shells.

#### Scenario: Windows executable without Unix execute bit is valid

- **WHEN** `platform` is `win32` and `shellPath` is an existing file with mode lacking `0o111`
- **THEN** `validateShell()` returns `true`

### Requirement: Shell Arguments

The system SHALL derive default shell arguments via `getShellArgs(shellPath)`, keyed on the path's basename (backslashes normalised first, so Windows paths resolve correctly). Login shells (`zsh`, `bash`) SHALL receive `['--login']`; all other shells (`sh`, `fish`, `cmd.exe`, `powershell.exe`, `pwsh.exe`, …) SHALL receive `[]`.

#### Scenario: Windows shell gets no login flag

- **WHEN** `shellPath` basename is `cmd.exe` or `powershell.exe`
- **THEN** `getShellArgs()` returns `[]`
