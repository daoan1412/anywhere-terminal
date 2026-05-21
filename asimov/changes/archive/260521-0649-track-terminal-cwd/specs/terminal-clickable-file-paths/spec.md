## MODIFIED Requirements

### Requirement: Path resolution chain

On receiving `openFile`, the extension host SHALL attempt to resolve `path` to an existing file URI in this exact order, stopping at the first hit:

1. If `path` is absolute (POSIX `/...` or Windows `<letter>:\...`), use it as-is.
2. Join with the PTY's **live** cwd from the OS process table (`SessionManager.getLiveCwd(sessionId)`, which queries the PTY child process's cwd via `/proc/<pid>/cwd` on Linux or `lsof -p <pid> -d cwd -Fn` on macOS — Windows returns `undefined`), if defined.
3. Join with the PTY's **OSC-reported** cwd (`SessionManager.getCurrentCwd(sessionId)`, populated by OSC 7 / OSC 633 emits), if defined.
4. Join with the PTY's **initial** cwd recorded at session spawn (`SessionManager.getInitialCwd(sessionId)`), if defined.
5. Join with each `vscode.workspace.workspaceFolders[i].uri.fsPath` in order.
6. Call `vscode.workspace.findFiles(include, "{**/node_modules/**,**/.git/**}", maxResults, token)` with a 2000ms timeout, where `maxResults` is read from `anywhereTerminal.fileSearch.maxResults` (default 50, clamped to `[1, 1000]`; `NaN`/`Infinity`/`throw` → default). `include` is built as follows: if `workspaceFolders.length > 0`, use the plain string glob `"**/" + escapeGlob(path)` (searches all workspace folders). Otherwise, when a workspace is NOT open but the PTY's live cwd or initial cwd is known, use `new vscode.RelativePattern(vscode.Uri.file(searchBase), "**/" + escapeGlob(path))` rooted at `liveCwd ?? initialCwd`; without either, skip findFiles and fall through to "File not found". This step is also skipped when `path` is absolute or contains `..` traversal segments (defense in depth — the absolute candidate was already tried in steps 1–5, and we refuse to send glob patterns that try to escape the search root). `token` is a fresh `vscode.CancellationTokenSource().token` cancelled on the 2s timeout so a slow filesystem walk doesn't keep enumerating after the click handler has returned. `escapeGlob` MUST wrap each glob meta character in `path` (`*`, `?`, `[`, `]`, `{`, `}`) in a literal char-class (e.g. `?` → `[?]`) so the click target is treated as a literal filename. The result count dictates UX:
   - **0 matches**: fall through to the "File not found" toast.
   - **1 match**: open it.
   - **≥2 matches**: present `vscode.window.showQuickPick` with all matches. Label = path relative to the matching workspace folder, with folder-name prefix when multi-root; absolute `fsPath` when no workspace is open or the match falls outside any workspace folder. Description = absolute path. User selects one → open it. ESC / cancel → no-op (no toast).

Existence MUST be verified via `vscode.workspace.fs.stat` for steps 1–5. A directory MUST be treated as "not a file" and fall through to the next candidate. If, after exhausting steps 1–5, **no** candidate hit as a file but at least one resolved as a directory, the host MUST silently abort (skip step 6, skip the "File not found" toast). Rationale: the user clicked something that exists on disk — just not as a file — so the toast would be misleading, and `findFiles` only returns files so it cannot find what the user actually clicked. Step 6's `findFiles` already returns only existing files; on timeout, exception, or zero matches, the resolution falls through to the "File not found" toast.

Rationale for ordering: step 2 (liveCwd) is the authoritative source for local sessions because it queries the OS process table directly, regardless of shell configuration. Step 3 (OSC-reported) is retained as a fallback when liveCwd is unavailable (Windows, or query failure) and remains the only path that works for SSH/remote sessions (where the local PID has no relation to the remote shell's cwd).
