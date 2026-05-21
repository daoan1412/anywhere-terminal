# Discovery: add-clickable-file-paths

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot | Done | finder subagent |
| External Reference (VSCode terminal links) | Done | finder subagent |
| Internal Patterns (drag-drop path tests) | Done | finder subagent |
| Constraint Check | Skipped | No new dep — `@xterm/xterm` already exposes `registerLinkProvider` |
| Memory Recall | Skipped | No prior decisions logged for this area |

## Key Findings

### 1. Existing link integration is already 80% of the harness

`src/webview/terminal/TerminalFactory.ts:172-177` constructs a `WebLinksAddon` whose click handler posts `{ type: "openLink", url }` to the extension host. Both providers (`TerminalViewProvider.ts:254` and `TerminalEditorProvider.ts:197`) dispatch that message to `openExternalLink()` (`src/providers/openExternalLink.ts`), which routes through `vscode.env.openExternal`. We can model the new file-path channel as a parallel message `openFile` reusing this exact wiring shape.

`WebLinksAddon` is itself a thin wrapper over xterm.js' public `terminal.registerLinkProvider(ILinkProvider)` API — same API we will call directly for file paths. No new dependency.

### 2. IPC is one-way today

`src/types/messages.ts:115-127` and `:270-286` define two discriminated unions. Every webview→extension message is fire-and-forget; the extension never responds to a specific request id. Introducing a synchronous validation roundtrip would be a new pattern (not impossible, but a noticeable surface change).

### 3. PTY does not track current cwd

`src/pty/PtySession.ts` passes `cwd` to `nodePty.spawn(...)` at construction time but never reads it back, and never updates after the shell `cd`s. There is no OSC 7 listener, no shell-integration script. Accurate "current cwd" is **not free** — it requires either:
- (a) Re-using only the initial cwd (stale after `cd`)
- (b) Adding an OSC 7 listener + emitting shell-integration script on shell startup
- (c) Letting the user accept the limitation: relative paths resolve relative to initial cwd

### 4. VSCode handles ~25 link suffix variants; the long tail is rare

`vscode/.../terminalLinkParsing.ts:75-126` enumerates the universe: `file:N`, `file:N:C`, `file:N:C-N2.C2`, `file(N,C)`, `file[N,C]`, `file#N`, `"file",N`, `"file", line N, col C`, `file 339`, ripgrep-style multi-line, `file:line N`, etc. In practice ~6 patterns cover `tsc`, `eslint`, `vitest`, `pytest`, `cargo`, `gcc`, `python tracebacks`, `git blame`, and `grep -n`. Cut to the common set.

### 5. VSCode validates async with TTL cache + tries multiple base paths

`terminalLinkResolver.ts:51` calls `fileService.stat(uri)` with a 10s TTL cache per remote authority (`:169`). Resolution tries: absolute, file://, `~`, cwd-relative, workspace-relative, WSL-converted. Falls back to `quickAccess` search when nothing resolves.

### 6. xterm.js link provider is callback-based and supports async deferral

`registerLinkProvider({ provideLinks(bufferLineNumber, callback) })` — the callback may be invoked asynchronously. This means: we can detect candidates synchronously, fire an IPC request to validate them, and call `callback(links)` when the reply arrives. Underline only appears after validation completes. Trade-off: brief delay between text rendering and underline appearing.

### 7. Performance caps matter on big scrollback

VSCode caps: 2000 chars/line, 10 resolved links/line, 1024 chars/link, 500-char context window per detector. Without caps a 10k-line scrollback × regex × IPC could janks the renderer. Adopt similar caps.

### 8. Test pattern to follow exists

`src/webview/DragDropHandler.test.ts:1-318` uses Vitest + `@vitest-environment jsdom`, mocks `DataTransfer`, and verifies posted messages. Same shape works for testing the link-provider callback: feed a fake xterm.js terminal stub, assert `callback(...)` is called with the expected `ILink[]`.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| xterm.js link API | `WebLinksAddon` for URLs | Custom provider for file paths | Add a new `FilePathLinkProvider` next to it |
| IPC message types | `openLink` (URL) | `openFile` (path + line + col) | Add `OpenFileMessage` to `WebViewToExtensionMessage` |
| Extension handler | `openExternalLink` | `openFileLink` opener | New `src/providers/openFileLink.ts` |
| PTY cwd tracking | Initial cwd only | Current cwd (or accept limitation) | Decision needed (Option D1 below) |
| Path validation | None | Verify file exists before opening | Decision needed (Option D2 below) |
| Link parsing | None | File-path + suffix regex | Port subset of VSCode's `terminalLinkParsing.ts` |
| Tests | Drag-drop path tests | Link provider unit tests + opener tests | Model after `DragDropHandler.test.ts` |

## Options

Two orthogonal decisions; presented as separate option sets.

### D1 — Path validation strategy

#### Option B (Recommended) — Underline-all, validate on click
Underline every regex match without checking file existence. On click, the extension `fs.stat`s and either opens or surfaces a "file not found" error toast. Simple, no new IPC pattern, M appetite. Risk: visual noise in scrollback-heavy sessions (false-positive underlines on path-like strings).

#### Option A — Eager batch-validate via IPC
On each `provideLinks(line)` call, webview sends candidate paths to the extension; extension `stat`s them (with TTL cache) and replies; underline appears after reply. Accurate. Adds first request/response pattern to the protocol. L appetite.

#### Option C — No validation, no underline-on-miss
Always underline, always send `openFile`; on miss, silently fail. Worst UX — recommended against.

### D2 — CWD source for relative paths

#### Option α (Recommended) — Initial PTY cwd + workspace fallback chain
Resolve relative paths against: (1) PTY's initial cwd recorded at spawn, (2) any workspace folder, (3) skip. Wrong if the user has `cd`'d, but absolute paths (most tool errors) are unaffected. S add-on.

#### Option β — Track current cwd via OSC 7
Add an OSC 7 listener in the PTY layer; ship a shell-integration script (bash/zsh `PROMPT_COMMAND`/`precmd`) injected at shell startup that emits `\e]7;file://...\e\\`. Accurate, but adds shell-integration surface and per-shell config complexity. M add-on.

#### Option γ — Workspace root only
Ignore PTY cwd entirely; resolve against `workspace.workspaceFolders[0]`. Wrong for non-workspace sessions and most `cd`'d sessions. Recommended against.

## Risks

1. **False-positive underlines (Option B)** — non-path strings matching the regex get underlined. *Mitigation*: tighten regex to require either a `/`, `\`, or a `.ext` extension; cap matches per line (≤10).
2. **Perf on large scrollback** — `provideLinks` fires per visible line on hover; unbounded regex could janks. *Mitigation*: adopt VSCode caps (2000 chars/line, regex with non-backtracking shape, max 10 matches).
3. **Path-traversal abuse** — terminal output is untrusted; a malicious program could print fake clickable paths. *Mitigation*: confirm dialog before opening files outside workspace (mirror `openExternalLink`'s confirm pattern is overkill; instead, only auto-open if path resolves under workspace or PTY cwd; otherwise show confirm).
4. **Cross-platform path separators** — Windows uses `\`, Mac/Linux `/`. *Mitigation*: detect platform via `navigator.platform` in webview, swap regex variant; extension already uses `vscode.Uri.file()` which normalizes.
5. **Wrapped buffer lines** — xterm.js may wrap long lines; a path can span two buffer rows. *Mitigation*: out of scope for v1 — document limitation; VSCode handles via `isWrapped` + multi-line context, which we can add later.
6. **Editor area vs sidebar webview parity** — two providers must both implement `openFile` handler. *Mitigation*: extract opener to `src/providers/openFileLink.ts`, both providers delegate (mirror existing `openExternalLink` pattern).

## Open Questions

- **None blocking** — the two open decisions (D1, D2) are presented as Gate 1 options.
