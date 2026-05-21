## ADDED Requirements

### Requirement: File path detection in terminal output

The system SHALL detect file paths in terminal buffer lines and present them as xterm.js `ILink` entries with `decorations.underline = true` and `decorations.pointerCursor = true`. Detection MUST support the following path forms:

- Bare path containing at least one path separator (`/` on POSIX, `\` or `/` on Windows) OR a file extension `.<1-8 alphanumerics>`.
- Path followed by `:LINE` (e.g. `src/foo.ts:42`).
- Path followed by `:LINE:COL` or `:LINE.COL` (e.g. `src/foo.ts:42:7`).
- Path followed by `(LINE,COL)`, `(LINE, COL)`, `(LINE:COL)` (e.g. `Foo.cs(42,7)`).
- Path followed by `[LINE,COL]` or `[LINE:COL]`.
- Quoted form `"PATH", line LINE` and `"PATH", line LINE, column COL` (Python tracebacks).
- Quoted form `"PATH":LINE` and `"PATH":LINE:COL`.

`LINE` and `COL` MUST be parsed as 1-based positive integers.

URL-shaped strings MUST NOT be detected as file paths. A candidate MUST be rejected if it matches `^(https?|file|ftp|ssh|git|mailto):` — URLs are handled by the existing `WebLinksAddon`; double-underlining is a defect.

When overlapping candidates are produced by different parser passes (e.g. the master regex and the quoted-traceback regex both span the same characters), the system SHALL keep the candidate with the longer matched text and discard the other.

### Requirement: openFile IPC message

The system SHALL define and dispatch a webview→extension message of shape `{ type: "openFile"; path: string; sessionId: string; line?: number; col?: number }` when the user activates an underlined file-path link. `path` MUST be the raw matched path text without the line/column suffix. `sessionId` MUST be the terminal session that produced the line.

### Requirement: Path resolution chain

On receiving `openFile`, the extension host SHALL attempt to resolve `path` to an existing file URI in this exact order, stopping at the first hit:

1. If `path` is absolute (POSIX `/...` or Windows `<letter>:\...`), use it as-is.
2. Join with the PTY's initial cwd recorded at session spawn (exposed via a `SessionManager.getInitialCwd(sessionId)` accessor).
3. Join with each `vscode.workspace.workspaceFolders[i].uri.fsPath` in order.

Existence MUST be verified via `vscode.workspace.fs.stat`. A directory MUST be treated as "not a file" and fall through to the next candidate.

### Requirement: Out-of-scope confirm dialog

When the resolved file path is NOT under the PTY's initial cwd AND NOT under any workspace folder, the system SHALL show a modal `vscode.window.showWarningMessage` with body `Open file outside workspace?\n\n<absolute path>` and buttons `Open` (returns the URI) and `Cancel` (aborts open). The dialog MUST be modal. No dialog is shown when the path is inside cwd or any workspace folder.

### Requirement: File-not-found error toast

When no candidate path resolves to an existing file, the system SHALL show `vscode.window.showErrorMessage("File not found: <original path>")` and MUST NOT open any editor.

### Requirement: Open at parsed position

When opening succeeds, the system SHALL call `vscode.window.showTextDocument(uri, { selection })` where `selection = new vscode.Range(line-1, col-1, line-1, col-1)` if both `line` and `col` are provided, `selection = new vscode.Range(line-1, 0, line-1, 0)` if only `line` is provided, and `selection` is omitted if neither is provided.

### Requirement: Performance caps for detection

The system MUST skip detection on any buffer line longer than 2000 characters and MUST return at most 10 links per buffer line. These caps protect terminal rendering on large scrollback.
