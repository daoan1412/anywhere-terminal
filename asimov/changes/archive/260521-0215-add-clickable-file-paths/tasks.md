## 1. IPC contract & session-cwd surface

- [x] 1_1 Add `OpenFileMessage` to webview→extension message union
  - **Deps**: none
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `openFile IPC message`; design.md D1, Interfaces §`OpenFileMessage`
  - **Scope**: `src/types/messages.ts`
  - **Acceptance**:
    - Outcome: `OpenFileMessage` interface exists with fields `type: "openFile"`, `path: string`, `sessionId: string`, `line?: number`, `col?: number`. It is included as a member of the `WebViewToExtensionMessage` discriminated union. `pnpm run check-types` passes.
    - Verify: manual pnpm run check-types passes
  - **Plan**:
    1. Add the `OpenFileMessage` interface immediately below the existing `OpenLinkMessage` declaration.
    2. Append `| OpenFileMessage` to the `WebViewToExtensionMessage` union, preserving alphabetic/grouped order with the other openX messages.

- [x] 1_2 Expose initial cwd from `SessionManager`
  - **Deps**: none
  - **Refs**: design.md D6, Interfaces §`SessionManager.getInitialCwd accessor`
  - **Scope**: `src/session/SessionManager.ts`, `src/session/SessionManager.test.ts`
  - **Acceptance**:
    - Outcome: `SessionManager` records the `cwd` value passed when each session is spawned and exposes `getInitialCwd(sessionId: string): string | undefined`. Returns `undefined` for unknown ids and for sessions spawned without a `cwd`.
    - Verify: unit src/session/SessionManager.test.ts
  - **Plan**:
    1. Find the existing session-spawn method (the one invoked from `TerminalViewProvider:159` / `TerminalEditorProvider:162` with `cwd: settings.cwd`). Read the current session record shape.
    2. Add an `initialCwd?: string` field to whatever per-session record `SessionManager` keeps; populate it from the spawn-time `cwd` argument.
    3. Add public method `getInitialCwd(sessionId): string | undefined` returning the stored value (or `undefined` when the record is missing or `initialCwd` was not set).
    4. Add a unit test: spawn a session with `cwd: "/tmp"`, assert `getInitialCwd(id) === "/tmp"`; spawn another without cwd, assert `undefined`; assert `undefined` for an unknown id.

## 2. Webview parser (pure, no DOM)

- [x] 2_1 Implement `detectFilePathLinks` parser
  - **Deps**: none
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `File path detection in terminal output`, `Performance caps for detection`; design.md D3, D4, D9, Interfaces §`ParsedFilePathLink`
  - **Scope**: `src/webview/links/filePathParser.ts`
  - **Acceptance**:
    - Outcome: Module exports `ParsedFilePathLink` interface and `detectFilePathLinks(lineText: string, platform: "posix" | "win32"): ParsedFilePathLink[]`. Returns `[]` when `lineText.length > 2000`. Caps results at 10. Detects all forms enumerated in spec §`File path detection in terminal output`. Parses `line`/`col` as 1-based positive integers. `text` field includes the suffix; `path` excludes it.
    - Verify: unit src/webview/links/filePathParser.test.ts
  - **Plan**:
    1. Create the file with the interface and function signature from design.md Interfaces §.
    2. Length-gate at 2000 chars first; return `[]`.
    3. Build the platform-conditional path-body char class: POSIX excludes `\s|<>(){}[]"'`; Windows adds support for `\` and a `<letter>:` drive prefix.
    4. Compose the master regex as: `(?<before>^|[\s'"\(\[])(?<path>(?:DRIVE)?PATH_BODY)(?<suffix>SUFFIX_VARIANTS)?` where SUFFIX_VARIANTS is the alternation of the 6 spec-listed forms (`:N`, `:N:C`, `:N.C`, `(N,C)`, `(N:C)`, `[N,C]`).
    5. Add a second regex for the quoted Python-traceback form: `(?:File )?"PATH"(?:, line N(?:, column C)?|:N(?::C)?)`.
    6. URL reject (D3 step 3): drop any candidate whose `path` matches `^(https?|file|ftp|ssh|git|mailto):`.
    7. Filter "looks like a file" (D3 step 4): path must contain `[/\\]` OR end with `\.[A-Za-z0-9]{1,8}`.
    8. Dedup on overlap (D3 step 6): if two candidates' `[index, index+text.length)` intervals overlap, keep the one with the longer `text`.
    9. Return at most 10 entries in line-position order; each entry's `index` is the offset of `path` start in the original line (NOT including the `before` capture).

- [x] 2_2 Test `detectFilePathLinks` exhaustively
  - **Deps**: 2_1
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `File path detection in terminal output`; design.md D3; existing model `src/webview/DragDropHandler.test.ts`
  - **Scope**: `src/webview/links/filePathParser.test.ts`
  - **Acceptance**:
    - Outcome: Test suite covers each spec-listed path form with at least one positive case; covers URL rejection (`https://`, `http://`, `file://`, `ftp://`, `mailto:`) — all expected to produce `[]`; covers negative cases (plain word, bare integer, prose with colons like `"the time is 12:34"`, version strings `"v1.2.3"`); covers boundary punctuation (path immediately followed by `,` `.` `)` `;`); covers cap (2000-char line → `[]`, line with 15 matches → length 10); covers both POSIX and Windows platforms with separator-specific cases (`C:\foo\bar.ts:42`, `/foo/bar.ts:42`); covers dedup-on-overlap: input `File "x.py", line 42` yields exactly ONE link with the longest text (the Python form). All tests pass.
    - Verify: unit src/webview/links/filePathParser.test.ts
  - **Plan**:
    1. Use vitest with `describe.each` over the 6 path forms × representative inputs.
    2. Add an "ignores URLs" describe block: each common scheme expects `[]`.
    3. Add an "ignores prose" describe block: `"the time is 12:34"`, `"version 1.2.3"` — all expect `[]`.
    4. Add a "performance caps" describe block: a 2001-char line returns `[]`; a constructed line with 15 valid paths returns length 10.
    5. Add a "platform branch" describe block covering Windows backslash + drive letter and POSIX forward slash.
    6. Add a "dedup on overlap" test: `File "src/x.py", line 42` produces exactly one entry whose `text` includes the `line 42` suffix.
    7. Assert each result's `text`, `index`, `path`, `line`, `col` shape.

## 3. Webview link provider (xterm.js wiring)

- [x] 3_1 Implement `FilePathLinkProvider`
  - **Deps**: 1_1, 2_1
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `File path detection in terminal output`, `openFile IPC message`; design.md D1, D2, D5, D10, D11, Interfaces §`FilePathLinkProvider`
  - **Scope**: `src/webview/links/FilePathLinkProvider.ts`
  - **Acceptance**:
    - Outcome: Class implements xterm.js `ILinkProvider`. `provideLinks(bufferLineNumber, callback)` reads the line text from `terminal.buffer.active.getLine(bufferLineNumber).translateToString(false)` (or equivalent), calls `detectFilePathLinks`, maps each result to an `ILink` with: `range` covering the matched `text` columns (xterm.js 1-based), `decorations: { underline: true, pointerCursor: true }`, `text: parsed.text`, `activate(_event, _text) => postMessage({ type: "openFile", path, sessionId, line, col })`. Invokes `callback(links)` (or `callback(undefined)` when none).
    - Verify: unit src/webview/links/FilePathLinkProvider.test.ts
  - **Plan**:
    1. Create the class with the constructor signature from Interfaces §.
    2. In `provideLinks`: get the buffer line; if `undefined`, callback with `undefined`.
    3. `translateToString(false)` to get plain text; pass to `detectFilePathLinks(text, this.platform)`.
    4. Map each `ParsedFilePathLink` to `ILink`. xterm.js buffer ranges are 1-based and `end.x` is INCLUSIVE of the last char (see design.md D11): `start = { x: parsed.index + 1, y: bufferLineNumber }`, `end = { x: parsed.index + parsed.text.length, y: bufferLineNumber }`.
    5. `activate` calls `this.postMessage({ type: "openFile", path: parsed.path, sessionId: this.sessionId, line: parsed.line, col: parsed.col })`. Omit `line`/`col` from the payload when `undefined` (don't send `undefined` fields).
    6. Hand `links` to `callback`; pass `undefined` if `links.length === 0`.

- [x] 3_2 Test `FilePathLinkProvider`
  - **Deps**: 3_1
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `File path detection in terminal output`, `openFile IPC message`; existing pattern `src/webview/test-utils/mockTerminal.ts`
  - **Scope**: `src/webview/links/FilePathLinkProvider.test.ts`
  - **Acceptance**:
    - Outcome: Tests verify: (a) `provideLinks` calls `callback(undefined)` for a blank/non-matching line, (b) for a line with `src/foo.ts:42`, callback receives one `ILink` with correct `range`, `text`, `decorations.underline === true`, `decorations.pointerCursor === true`, (c) calling `link.activate(fakeEvent, link.text)` posts an `openFile` message with `path: "src/foo.ts"`, `line: 42`, no `col`, and the correct `sessionId`, (d) cap behavior: line with 15 matches yields callback array length 10.
    - Verify: unit src/webview/links/FilePathLinkProvider.test.ts
  - **Plan**:
    1. Reuse or stub `mockTerminal` from `src/webview/test-utils/mockTerminal.ts` — needs `buffer.active.getLine(n)` returning an object with `translateToString(false)`.
    2. Construct `FilePathLinkProvider` with a `postMessage` spy.
    3. For each scenario, call `provider.provideLinks(0, callback)` synchronously; assert `callback` was called with the expected `ILink[]` shape.
    4. For the activate path, invoke `link.activate({} as MouseEvent, link.text)` and assert the spy received the expected message.

- [x] 3_3 Wire `FilePathLinkProvider` into `TerminalFactory.createTerminal`
  - **Deps**: 3_1
  - **Refs**: design.md D1, D4
  - **Scope**: `src/webview/terminal/TerminalFactory.ts`
  - **Acceptance**:
    - Outcome: After `terminal.loadAddon(webLinksAddon)` (currently line ~177), `TerminalFactory` calls `terminal.registerLinkProvider(new FilePathLinkProvider({ terminal, sessionId: id, postMessage: (msg) => this.postMessage(msg), platform: navigator.platform.includes("Win") ? "win32" : "posix" }))`. Manual smoke: running the extension and printing `src/extension.ts:1` in the terminal shows an underline on the text and clicking it sends an `openFile` message.
    - Verify: manual print "src/extension.ts:1" in terminal, hover shows underline, click is handled (verify via existing TerminalViewProvider/TerminalEditorProvider tests after task 4_3)
  - **Plan**:
    1. Add `import { FilePathLinkProvider } from "../links/FilePathLinkProvider";` at the top of `TerminalFactory.ts`.
    2. Locate the existing `terminal.loadAddon(webLinksAddon)` call in `createTerminal`.
    3. Immediately after that line, add the `terminal.registerLinkProvider(...)` call with the constructor args listed in Outcome.

## 4. Extension host opener

- [x] 4_1 Implement `openFileLink` opener
  - **Deps**: 1_1, 1_2
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `Path resolution chain`, `Out-of-scope confirm dialog`, `File-not-found error toast`, `Open at parsed position`; design.md D7, D8 (normalization + Windows case-insensitive + equality-as-inside); existing pattern `src/providers/openExternalLink.ts`
  - **Scope**: `src/providers/openFileLink.ts`
  - **Acceptance**:
    - Outcome: Module exports `openFileLink(msg: OpenFileMessage, deps): Promise<void>`. Behavior: builds a candidate URI list per spec `Path resolution chain` (absolute → PTY initial cwd → workspace folders in order); calls `deps.stat` on each; first hit that is a regular file (not a directory) wins. If the resolved fsPath is NOT under PTY cwd and NOT under any workspace folder, calls `deps.showWarning` with the exact text from spec `Out-of-scope confirm dialog`, modal, with buttons `["Open", "Cancel"]`; opens only if user picks `Open`. If no candidate resolves, calls `deps.showError("File not found: <msg.path>")` and does not open. Successful open calls `deps.showTextDocument(uri, { selection })` with selection per spec `Open at parsed position`.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Create the module with the function signature from design.md Interfaces §.
    2. Helper `isAbsolute(p, platform)` — POSIX `p.startsWith("/")`; Windows `/^[A-Za-z]:[\\/]/.test(p)`. Use `process.platform === "win32"` to pick.
    3. Build candidate list: `[absolutePath?]` ∪ `[join(initialCwd, p)]` ∪ `workspaceFolders.map(f => join(f.uri.fsPath, p))`. Dedupe.
    4. Iterate candidates; for each, `await deps.stat(vscode.Uri.file(candidate))`; catch errors as "doesn't exist"; if `stat.type === vscode.FileType.File`, accept; else continue.
    5. If none accepted: `await deps.showError(`File not found: ${msg.path}`)` and return.
    6. Scope check (D8): normalize accepted `target = path.resolve(uri.fsPath)`. For each base (`initialCwd`, workspace-folder fsPaths), normalize via `path.resolve(base)`. On `process.platform === "win32"`, lower-case both target and base. INSIDE iff `target === base`, OR `path.relative(base, target) === ""`, OR `path.relative(base, target)` does not start with `..` and is not absolute. If outside ALL bases, call `deps.showWarning("Open file outside workspace?\n\n" + uri.fsPath, { modal: true }, "Open", "Cancel")`. If the result is not `"Open"`, return.
    7. Build selection: `line` and `col` both → `new vscode.Range(line-1, col-1, line-1, col-1)`; only `line` → `new vscode.Range(line-1, 0, line-1, 0)`; neither → omit `selection`.
    8. `await deps.showTextDocument(vscode.Uri.file(fsPath), selection ? { selection } : undefined)`.

- [x] 4_2 Test `openFileLink`
  - **Deps**: 4_1
  - **Refs**: specs/terminal-clickable-file-paths/spec.md `Path resolution chain`, `Out-of-scope confirm dialog`, `File-not-found error toast`, `Open at parsed position`; design.md D7
  - **Scope**: `src/providers/openFileLink.test.ts`
  - **Acceptance**:
    - Outcome: Tests cover: (a) absolute path that exists → opens, no warning; (b) relative path resolved via PTY cwd → opens; (c) relative path resolved via workspace fallback when cwd misses → opens; (d) nothing resolves → `showError` called with `"File not found: <path>"`, no open; (e) resolved path outside cwd + workspace → modal warning shown, "Cancel" → no open; "Open" → opens; (f) resolved path equal to a workspace folder root → treated as INSIDE, no warning; (g) selection: both line+col → Range(line-1, col-1, ...); only line → Range(line-1, 0, ...); neither → no selection arg; (h) sessionId unknown → `getInitialCwd` returns undefined → falls through to workspace folders.
    - Verify: unit src/providers/openFileLink.test.ts
  - **Plan**:
    1. Stub all deps: `stat` returns a configurable map of `{path: FileStat}`, `showWarning`/`showError`/`showTextDocument` are vi.fn().
    2. For each scenario, configure stat map + workspaceFolders + getInitialCwd return value, invoke `openFileLink(msg, deps)`, assert spy calls.
    3. Use `path.posix` joining in tests for determinism; pass absolute `/tmp/...` paths.

- [x] 4_3 Wire `openFile` handler into both providers
  - **Deps**: 1_2, 4_1
  - **Refs**: design.md D7; existing pattern at `src/providers/TerminalViewProvider.ts:254` and `src/providers/TerminalEditorProvider.ts:197` (case `"openLink"`)
  - **Scope**: `src/providers/TerminalViewProvider.ts`, `src/providers/TerminalEditorProvider.ts`
  - **Acceptance**:
    - Outcome: Both providers add `case "openFile":` to their `handleMessage` switch, immediately after the existing `case "openLink":`. The handler calls `openFileLink(message, { getInitialCwd: (id) => this.sessionManager.getInitialCwd(id), workspaceFolders: vscode.workspace.workspaceFolders, stat: (uri) => vscode.workspace.fs.stat(uri), showWarning: vscode.window.showWarningMessage, showError: vscode.window.showErrorMessage, showTextDocument: vscode.window.showTextDocument })`. The existing `openLink` tests still pass; `pnpm run check-types` passes; `pnpm run lint` passes.
    - Verify: unit src/providers/TerminalViewProvider.test.ts (existing tests still pass; one new test asserts the `openFile` case forwards to `openFileLink` — use module-level vi.mock on `./openFileLink`)
  - **Plan**:
    1. Import `openFileLink` in both providers.
    2. Add the `case "openFile":` arm to each switch immediately after `case "openLink":`.
    3. In each provider's existing `*.test.ts`, mock `./openFileLink` at module scope and add a single test that an inbound `openFile` message dispatches to the mocked function with the expected deps shape.

## 5. Verification

- [x] 5_1 Run project verification commands
  - **Deps**: 1_1, 1_2, 2_1, 2_2, 3_1, 3_2, 3_3, 4_1, 4_2, 4_3
  - **Refs**: `asimov/project.md` §Commands
  - **Scope**: (no code) — runs `pnpm run check-types`, `pnpm run lint`, `pnpm run test:unit`
  - **Acceptance**:
    - Outcome: All three commands exit 0.
    - Verify: manual pnpm run check-types && pnpm run lint && pnpm run test:unit all green
  - **Plan**:
    1. Run the three commands in order; fix any errors before declaring this task complete.

- [ ] 5_2 Manual smoke
  - **Deps**: 5_1
  - **Refs**: proposal.md §UI Impact & E2E
  - **Scope**: (no code) — launches the extension in a development host and exercises three flows
  - **Acceptance**:
    - Outcome: In the dev host: (a) print `echo "src/extension.ts:1"` in a terminal opened in the sidebar — text underlined, click opens `src/extension.ts` at line 1; (b) print `echo "/tmp/does-not-exist.ts:1"` — click shows the "File not found" error toast; (c) print an absolute path outside workspace AND outside terminal cwd — click shows the modal confirm; (d) repeat (a) in the editor-area terminal — same behavior; (e) run `cd src && echo "extension.ts:1"` — verify the stale-cwd limitation: click either resolves via workspace fallback (acceptable) or fails with "File not found" (documents the OSC 7 follow-up); (f) print `echo "https://example.com/path/page.html"` — URL is underlined by `WebLinksAddon` only, NOT double-underlined.
    - Verify: manual smoke flows (a)-(d) succeed in extension dev host
  - **Plan**:
    1. `pnpm run watch` (or launch via VS Code's `F5` Extension Host); open both a sidebar terminal and an editor terminal; run the four flows; record results in the Revision Log.
