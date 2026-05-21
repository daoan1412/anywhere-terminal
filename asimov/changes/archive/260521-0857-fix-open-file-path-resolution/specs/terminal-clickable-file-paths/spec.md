## MODIFIED Requirements

### Requirement: File path detection in terminal output

The system SHALL detect file paths in terminal buffer lines and present them as xterm.js `ILink` entries with `decorations.underline = true` and `decorations.pointerCursor = true`. Detection MUST support the following path forms:

- Bare path containing at least one path separator (`/` on POSIX, `\` or `/` on Windows) OR a file extension `.<1-8 alphanumerics>`.
- Path followed by `:LINE` (e.g. `src/foo.ts:42`).
- Path followed by `:LINE:COL` or `:LINE.COL` (e.g. `src/foo.ts:42:7`).
- Path followed by `(LINE,COL)`, `(LINE, COL)`, `(LINE:COL)` (e.g. `Foo.cs(42,7)`).
- Path followed by `[LINE,COL]` or `[LINE:COL]`.
- Quoted form `"PATH", line LINE` and `"PATH", line LINE, column COL` (Python tracebacks). Inside the quotes, PATH MAY contain spaces.
- Quoted form `"PATH":LINE` and `"PATH":LINE:COL`. Inside the quotes, PATH MAY contain spaces.
- Tilde-prefixed path (`~/...`, `~`) — `~` MUST be retained in the matched text (resolver expands).
- `file://` URI form (`file:///abs/path`, with or without percent-encoding) — entire URI MUST be the matched path text.

The **bare-path body** is the character set used between boundaries when no quoting is present. It MUST be: `[^\s'"<>(){}\[\]|]+`. That set excludes whitespace and the structural delimiters `'"<>(){}[]|`. It explicitly INCLUDES: ASCII alphanumerics, `_`, `.`, `/`, `\` (Windows), `@`, `~`, `+`, `-`, `#`, `&`, `=`, `%`, `:` (when not consumed by the suffix grammar), and non-ASCII Unicode letters (CJK, accented characters). Bare paths containing spaces or parentheses are NOT detected — the user must use a quoted form to claim them as a path.

URL-shaped strings other than `file://` MUST NOT be detected as file paths. A candidate MUST be rejected if it matches `^(https?|ftp|ssh|git|mailto):` — these are handled by `WebLinksAddon`. `file://` is the only scheme this detector claims.

When overlapping candidates are produced by different parser passes (e.g. the bare regex and the quoted-traceback regex both span the same characters), the system SHALL keep the candidate with the longer matched text and discard the other.

`LINE` and `COL` MUST be parsed as 1-based positive integers.

### Requirement: Path resolution chain

On receiving `openFile`, the extension host SHALL resolve `path` to an existing file URI by trying ordered candidates from each source below and stopping at the first hit. **Each cwd source (liveCwd, currentCwd, initialCwd, every workspaceFolder) MUST fan out into multiple candidates via the reverse-segment-match algorithm**; a single `path.join` is insufficient.

#### Pre-resolution transforms

Before candidate generation, the path MUST be normalized once:

1. **`file://` URI**: if `path` starts with `file://`, parse via `vscode.Uri.parse(path, true)` inside a try/catch. The parsed URI MUST have `scheme === "file"` and a non-empty `fsPath`; otherwise fall through to the "File not found" toast. Percent-encoded path bytes are decoded by `vscode.Uri.parse` automatically. `authority` (host component) is IGNORED — any value accepted. `query` and `fragment` MUST be empty; a non-empty `query` or `fragment` causes fall-through to "File not found" (a clicked path containing literal `?` or `#` will not be wrapped in a `file://` URI by upstream callers).
2. **Tilde expansion**: if `path` starts with `~/` or equals `~`, replace the leading `~` with `os.homedir()`. Bare `~` MUST resolve to the home directory itself (then treated as a directory by the stat check and falls through). `~user` (other-user home) is NOT supported and MUST be left as-is.

After transform, the candidate chain runs:

1. **Absolute**: if the transformed path is absolute (POSIX `/...`, Windows `<letter>:[\\/]...`), use it as the sole candidate from this branch and SKIP the cwd-fan-out (steps 2-5).
2. **liveCwd fan-out**: `resolveCwdRelative(liveCwd, path)` — see algorithm below.
3. **currentCwd fan-out**: `resolveCwdRelative(currentCwd, path)`.
4. **initialCwd fan-out**: `resolveCwdRelative(initialCwd, path)`.
5. **Workspace-folder fan-out**: for each `vscode.workspace.workspaceFolders[i].uri.fsPath`, `resolveCwdRelative(folder, path)`.
6. **findFiles fallback**: see the "findFiles fallback" sub-requirement below.

All candidates from all sources MUST be deduplicated via `path.resolve(candidate)` + `Set` before stat checks. Stat MUST verify each candidate via `vscode.workspace.fs.stat`. A `FileStat` whose `type` has the `Directory` bit set (`(type & FileType.Directory) !== 0`) MUST be treated as a directory and fall through — this handles both plain directories (`type === 2`) and any provider that reports symlink-to-directory with the Directory bit set (e.g. `type === 66`).

#### `resolveCwdRelative(cwd, link)` algorithm

Returns an ordered list of candidate absolute paths. Algorithm (ported from VS Code `terminalLinkHelpers.ts:221-251`):

1. If `cwd` is undefined, empty, or not absolute, return `[]`.
2. Select the platform-aware path module: `path.posix` when `platform === "linux" | "darwin" | "freebsd"`, `path.win32` when `platform === "win32"`. All `join` / `resolve` / segment operations inside the algorithm MUST use that module — never the host's `path`.
3. Split `cwd` and `link` on the selected separator; drop empty segments produced by leading/trailing/duplicate separators (`filter(Boolean)`). Reverse `cwd` segments.
4. If `linkSegments.length <= 1` (e.g. `foo.md` with no separator), return `[selected.resolve(selected.join(cwd, link))]` — there is no leading segment to potentially strip, so the algorithm degenerates to a single candidate equivalent to `path.join`.
5. Initialize `commonDirs = 0`, `result = []`. For `i = 0` to `cwdSegments.length - 1`:
   - Push `selected.resolve(cwd + sep + linkSegments.slice(commonDirs).join(sep))`.
   - If `cwdSegments[i] === linkSegments[i]` (case-sensitive on POSIX, case-insensitive on Windows), increment `commonDirs`; else break the loop.
6. Return `result`.

Worked examples:

- `cwd=/x/y/a`, `link=a/file.md` → `['/x/y/a/a/file.md', '/x/y/a/file.md']`.
- `cwd=/home/common`, `link=common/file.md` → `['/home/common/common/file.md', '/home/common/file.md']`.
- `cwd=/x/y`, `link=a/file.md` → `['/x/y/a/file.md']` (no common suffix, loop breaks on first compare).
- `cwd=/x/y/a`, `link=file.md` (no separator) → `['/x/y/a/file.md']` (single-segment short-circuit).
- `cwd=""` or `cwd=undefined` → `[]`.
- `cwd=/x/y/a/`, `link=a/file.md` → `['/x/y/a/a/file.md', '/x/y/a/file.md']` (trailing slash on cwd is normalized by `filter(Boolean)`).
- `cwd=C:\\X\\A`, `link=a\\file.md`, platform=win32 → `['C:\\X\\A\\a\\file.md', 'C:\\X\\A\\file.md']` (case-insensitive match on `A` vs `a`).

#### findFiles fallback

When all step-1-5 candidates miss (no file hit; directory hits do not count), the system SHALL `vscode.workspace.findFiles(include, exclude, maxResults, token)` with a **single 2000ms timeout shared across both findFiles invocations below**. `exclude` MUST be the literal glob string `{**/node_modules/**,**/.git/**}`. `maxResults` is read from `anywhereTerminal.fileSearch.maxResults` (default 50, clamped to `[1, 1000]`; `NaN`, `Infinity`, negative, or a throw from `getConfiguration` MUST fall back to the default).

Pattern construction:

- If `path` contains no separator (e.g. `foo.md`): `include = "**/" + escapeGlob(path)`.
- If `path` contains a separator (e.g. `a/file.md`):
  1. **Full-path search**: `include = "**/" + escapeGlob(path)`. If `matches.length > 0`, use that result set.
  2. **Basename fallback**: if step 1 returned 0 matches AND the timeout has not yet expired, issue a second `findFiles` with `include = "**/" + escapeGlob(basename(path))`. Filter the result set to those whose `uri.fsPath` ends with the OS-separator-normalized `path` (case-sensitive on POSIX, case-insensitive on Windows). Use the filtered set.

The same `vscode.CancellationTokenSource` MUST be threaded through both invocations and cancelled when the shared 2000ms budget expires.

`include` MUST be wrapped in `new vscode.RelativePattern(vscode.Uri.file(searchBase), pattern)` when no workspace is open but `liveCwd` or `initialCwd` is known (`searchBase = liveCwd ?? initialCwd`). When neither workspace nor cwd is known, `findFiles` MUST be skipped.

`escapeGlob` MUST wrap each glob meta character in `path` (`*`, `?`, `[`, `]`, `{`, `}`) in a literal character class (e.g. `?` → `[?]`) so the click target is treated as a literal filename.

`findFiles` MUST be skipped when the path is absolute or contains a `..` segment (defense in depth — the absolute candidate was already tried, and we refuse to send escape-patterns).

Match-count UX:

- **0 matches**: fall through to "File not found" toast (but: silent abort if any step-1-5 candidate hit as a directory — see existing "silent abort on directory" rule).
- **1 match**: open it.
- **≥2 matches**: present `vscode.window.showQuickPick` with all matches (label = workspace-relative path with multi-root disambiguation as today; description = absolute `fsPath`). ESC / cancel → no-op (no toast).

#### Out-of-scope and security

Rationale for `currentCwd` exclusion from trust-bases (for the out-of-scope modal) is UNCHANGED: shell-emitted OSC 7/633 is untrusted input and MUST NOT be permitted to disable the modal. This is enforced in the "Out-of-scope confirm dialog" requirement. **`liveCwd` is ALSO excluded from trust-bases for this change** — adding it would broaden the trust boundary; a separate security-reviewed change is required to include it.

## ADDED Requirements

### Requirement: Tilde expansion in resolver

The system SHALL expand a leading `~` in `OpenFileMessage.path` to `os.homedir()` before candidate generation. Forms:

- `~` (alone) → `os.homedir()` (resolves to the home directory; treated as a directory by `fs.stat` and falls through silently if no file candidate hits).
- `~/foo/bar` → `<os.homedir()>/foo/bar`.
- `~user/...` (other-user home) → NOT expanded; left as-is. The path then falls through the cwd-fan-out and `findFiles`, almost certainly producing "File not found". This is intentional: per-user resolution requires `getpwnam` semantics this codebase does not implement.

Expansion MUST happen exactly once, before any `path.join` or `path.resolve`.

### Requirement: file:// URI handling in resolver

The system SHALL accept `file://` URIs as `OpenFileMessage.path`. On receipt:

1. Parse via `vscode.Uri.parse(path, true)` inside try/catch. On parse error, fall through to "File not found" toast (do not throw).
2. The parsed URI MUST have `scheme === "file"`; otherwise fall through.
3. The parsed URI MUST have empty `query` AND empty `fragment`; non-empty `query` or `fragment` fall through.
4. Use the resulting `Uri.fsPath` as a fully-resolved absolute path candidate.
5. The host component (`authority`) is IGNORED (matches existing OSC 7 behaviour — SSH/remote contexts emit non-local hostnames legitimately).
6. Percent-encoded path bytes MUST be decoded by `vscode.Uri.parse` automatically.

`file://` paths MUST skip the cwd-fan-out (they are already absolute).
