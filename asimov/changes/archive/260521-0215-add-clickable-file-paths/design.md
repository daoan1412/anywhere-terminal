# Design: add-clickable-file-paths

## Decisions

### D1: Call `terminal.registerLinkProvider` directly (no addon wrapper)

Mirror the existing `WebLinksAddon` integration shape but skip the addon wrapper. We control all detection logic and don't want addon lifecycle indirection. Registration happens inside `TerminalFactory.createTerminal()` immediately after the existing `terminal.loadAddon(webLinksAddon)` call, capturing `id` (tabId/sessionId) and `postMessage` in closure.

Rejected: writing a custom xterm addon class. Adds a layer with no benefit; we own both the call site and the provider.

### D2: New module layout under `src/webview/links/`

Place all webview-side path-detection code in a new directory parallel to `src/webview/terminal/`:

```
src/webview/links/
  filePathParser.ts          # pure parsing, no DOM/xterm dependency
  filePathParser.test.ts     # vitest, in-source
  FilePathLinkProvider.ts    # implements xterm.js ILinkProvider; depends on parser + postMessage
  FilePathLinkProvider.test.ts
```

Rationale: parser is pure and unit-testable in isolation; provider depends on xterm.js types and `postMessage` injection. The split mirrors how `InputHandler.ts` (logic) sits separately from `TerminalFactory.ts` (wiring).

### D3: Parser exports `detectFilePathLinks(lineText, platform): ParsedFilePathLink[]`

Single pure function. Input: full buffer-line text plus `"posix" | "win32"`. Output: zero or more `ParsedFilePathLink` records (see Interfaces §). Algorithm:

1. Bail if `lineText.length > 2000` — return `[]`.
2. Walk the line with one master regex covering suffixed + bare-path forms. Run a second pass with a dedicated regex for the quoted Python-traceback form `(File )?"PATH", line N(?:, column C)?` (and `"PATH":N(:C)?`).
3. **Reject URL schemes**: before accepting a path candidate, reject if it matches `^(https?|file|ftp|ssh|git|mailto):`. URLs are handled by `WebLinksAddon`; we must not double-underline or capture `http://x.com/y` as a path.
4. **"Looks like a file" gate**: path candidate must contain a path separator (`/` always; `\` on Windows) OR end with `\.[A-Za-z0-9]{1,8}` (an extension). Filters out plain words, version strings, and integers.
5. **Cap at 10** results per line (in order of position).
6. **Dedup on overlap**: when the master regex and the quoted-traceback regex both produce a candidate covering the same span of `lineText`, keep the one with the longer matched `text` (richer suffix wins) and drop the other.
7. For each surviving candidate, return `{ text, index, path, line?, col? }` where `text` includes the matched suffix (so the underline covers `file.ts:42:7`) and `path` is just the file portion.

**Backtracking safety in JavaScript**: JS regex does not support possessive/atomic groups, so safety comes from (a) the 2000-char input gate, (b) explicit non-alternation character classes for the path body (no nested `(a|b)*` ambiguity), and (c) anchored boundary chars before/after the path. Adversarial inputs are bounded to O(2000) work.

Rejected: porting VSCode's full `terminalLinkParsing.ts` (~25 variants). 80% gain at 30% complexity by supporting the 6 common forms enumerated in the spec.

### D4: Platform detection via `navigator.platform` in webview

Webview reads `navigator.platform.includes("Win")` once at provider construction; passes `"posix"` or `"win32"` to the parser. Extension host already operates per-platform via `vscode.Uri.file()` (which normalizes), so no extension-side branching needed.

### D5: Validate file existence lazily — on activation only

Per Gate 1 D1: underline every parser match without `fs.stat`. The opener (extension host) calls `vscode.workspace.fs.stat` only when handling `openFile`. No webview→extension validation request/response is introduced (preserving the existing fire-and-forget IPC discipline; ref discovery.md §2).

### D6: PTY initial cwd surface via `SessionManager.getInitialCwd(sessionId): string | undefined`

`SessionManager` already constructs sessions with `cwd: settings.cwd` (see discovery.md §1). Capture that argument in the session record and add a read-only accessor. `PtySession` itself is NOT modified — `SessionManager` already holds the value at spawn time.

Rejected: an `OSC 7` listener on `PtySession.data` events with shell-integration script injection. Real-time cwd is more accurate but requires shipping shell-init scripts and per-shell config (bash `PROMPT_COMMAND`, zsh `precmd`, fish `pwd_hook`). Documented as a follow-up; absolute paths (most tool output) work fine without it.

### D7: Opener as a standalone module `src/providers/openFileLink.ts`

Mirror `openExternalLink.ts`. Signature:

```ts
export async function openFileLink(
  msg: OpenFileMessage,
  deps: {
    getInitialCwd(sessionId: string): string | undefined;
    workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
    stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
    showWarning: typeof vscode.window.showWarningMessage;
    showError: typeof vscode.window.showErrorMessage;
    showTextDocument: typeof vscode.window.showTextDocument;
  },
): Promise<void>;
```

Dependency injection lets the unit test stub `stat`, `showWarning`, `showError`, `showTextDocument`. Both providers (`TerminalViewProvider`, `TerminalEditorProvider`) call the same function with concrete `vscode.*` deps.

### D8: Confirm scope check

After the resolution chain produces a `vscode.Uri`, compute its normalized `fsPath` via `path.resolve(uri.fsPath)` and check whether it is a descendant of the PTY initial cwd OR any workspace folder. Algorithm for each base:

1. Normalize the base with `path.resolve(base)`.
2. On Windows (`process.platform === "win32"`), lower-case both `target` and `base` before comparison (Windows paths are case-insensitive).
3. If `target === base` → INSIDE (equality counts as inside).
4. Compute `rel = path.relative(base, target)`. If `rel === ""` → INSIDE. If `rel.startsWith("..")` OR `path.isAbsolute(rel)` → OUTSIDE. Otherwise INSIDE.

If OUTSIDE all bases, show the modal confirm. Otherwise open directly.

### D9: Cross-platform path separator handling in parser

POSIX regex: path can contain `/` and `[\w\-.@~+]` characters; no `\s|<>(){}[]"'` in the path body.
Windows regex: same plus allow `\` and a leading `<drive-letter>:` prefix. Reject UNC paths (`\\server\...`) for v1 — uncommon in error output.

A single regex with `[/\\]` character class handles both separators; platform-specific branch only handles drive prefix and surrounding char class exclusions.

### D11: xterm.js `ILink.range` end column is INCLUSIVE

xterm.js' `IBufferRange` uses 1-based positions, and `end.x` is INCLUSIVE of the last character — i.e. for `text` of length L starting at 0-based offset `index`, the range is `start.x = index + 1`, `end.x = index + L` (NOT `index + L + 1`). The wiring in task 3_1 reflects this. Cite when implementing.

### D10: Modifier key for activation — defer to xterm.js default

xterm.js' link provider fires `activate` on plain click by default; underline appears on hover always. We do NOT override modifier behavior in v1 — matches existing `WebLinksAddon` UX in this codebase (`TerminalFactory.ts:173-175` registers WebLinksAddon with no modifier override). Users who want different behavior can configure via xterm settings later.

## Interfaces

### `OpenFileMessage` (added to `src/types/messages.ts`)

```ts
export interface OpenFileMessage {
  type: "openFile";
  /** Raw matched path text (no line/col suffix) */
  path: string;
  /** Source terminal session id (used to look up initial cwd) */
  sessionId: string;
  /** Optional 1-based line number from suffix */
  line?: number;
  /** Optional 1-based column number from suffix */
  col?: number;
}
```

Add to the `WebViewToExtensionMessage` union.

### `ParsedFilePathLink` (in `src/webview/links/filePathParser.ts`)

```ts
export interface ParsedFilePathLink {
  /** Full matched substring including any suffix (used as ILink text + range) */
  text: string;
  /** 0-based column index where `text` starts in the line */
  index: number;
  /** Path portion only (suffix stripped) */
  path: string;
  /** 1-based line number, if suffix matched */
  line?: number;
  /** 1-based column number, if suffix matched */
  col?: number;
}

export function detectFilePathLinks(
  lineText: string,
  platform: "posix" | "win32",
): ParsedFilePathLink[];
```

### `FilePathLinkProvider` (in `src/webview/links/FilePathLinkProvider.ts`)

```ts
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { WebViewToExtensionMessage } from "../../types/messages";

export interface FilePathLinkProviderDeps {
  terminal: Terminal;
  sessionId: string;
  postMessage: (msg: WebViewToExtensionMessage) => void;
  platform: "posix" | "win32";
}

export class FilePathLinkProvider implements ILinkProvider {
  constructor(deps: FilePathLinkProviderDeps);
  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void;
}
```

### `SessionManager.getInitialCwd` accessor

```ts
class SessionManager {
  // ... existing
  getInitialCwd(sessionId: string): string | undefined;
}
```

Returned value is the `cwd` argument passed when the session was spawned; `undefined` for unknown ids or sessions spawned without a cwd.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| Parser regex | False-positive underlines on prose | D3 step 4 requires either `/`/`\` or `.ext`; capped to 10/line; parser unit tests cover negative cases (plain words, numbers, hashes) |
| Parser regex | URL false-positives (`http://x.com/y` matches "/" rule) | D3 step 3 explicit URL-scheme reject; parser test exercises `https://`, `http://`, `file://`, `ftp://`, `mailto:` |
| Parser regex | Catastrophic backtracking on adversarial input | JS has no possessive groups — safety via (a) 2000-char input gate, (b) non-alternation path-body char class, (c) bounded `text` length. O(n) work per line. Parser test feeds long pathological inputs |
| Parser regex | Master + quoted regex both match same span → duplicate underline | D3 step 6 dedup-on-overlap: longer-text wins; parser test asserts no duplicates for `File "x.py", line 42` |
| Link provider | Janks renderer on hover over scrollback | `provideLinks` is callback-based and per-line; D3 caps and the 2000-char gate keep work O(line length) |
| IPC | `openFile` arrives after session disposed | Extension host opener treats `getInitialCwd(sessionId) === undefined` as "no PTY cwd" and falls through to workspace folders; tested by unit test |
| Opener | Race between `stat` and user dismissing dialog | `showWarningMessage` returns once user responds; no shared state mutated between stat and open; tested by sequencing stub |
| Security | Malicious terminal output printing fake paths | D8 confirm dialog for out-of-cwd, out-of-workspace paths; mirrors `openExternalLink` modal pattern; opener test asserts confirm is shown |
| Cross-platform | Windows path with drive letter resolves wrong | D9 platform branch in parser; opener uses `vscode.Uri.file()` for normalization; manual smoke on both platforms before merge |
| Two providers | Drift between `TerminalViewProvider` and `TerminalEditorProvider` handlers | Both delegate to the same `openFileLink()` function (D7); test exercises the function, not the providers |
| PTY cwd staleness | User `cd`'d but resolution uses initial cwd | Documented limitation in proposal §Out of scope; absolute paths (most tool output) unaffected; workspace-folder fallback covers most relative cases |
