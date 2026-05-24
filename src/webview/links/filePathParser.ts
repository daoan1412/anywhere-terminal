// src/webview/links/filePathParser.ts — Pure file-path detection for terminal output.
//
// Detects file paths in a single terminal buffer line and returns them with
// optional line/column suffix data. No DOM, no xterm.js dependency — testable
// in isolation. Caps protect the renderer on large scrollback.
//
// See: asimov/specs/terminal-clickable-file-paths/spec.md
// See: asimov/changes/add-clickable-file-paths/design.md D3, D4, D9

/** A single file-path candidate detected in a terminal line. */
export interface ParsedFilePathLink {
  /** Full matched substring including any suffix; what the underline covers. */
  text: string;
  /** 0-based column index where `text` starts in the source line. */
  index: number;
  /** Path portion only — line/column suffix stripped. */
  path: string;
  /** 1-based line number parsed from the suffix, if present. */
  line?: number;
  /** 1-based column number parsed from the suffix, if present. */
  col?: number;
}

const MAX_LINE_LENGTH = 2000;
const MAX_RESULTS = 10;

// `file:` removed: `file:///...` URIs are now claimed by this detector and
// handed to the resolver (which decodes via `vscode.Uri.parse`). Web URLs
// remain handled by xterm's built-in `WebLinksAddon`.
const URL_SCHEME_REGEX = /^(?:https?|ftp|ssh|git|mailto):/i;
const TRAIL_PUNCT_REGEX = /[.,;:!?]+$/;
// Path-extension shape used to gate `@`-mention acceptance. 1-8 alphanumeric
// chars after a final `.`, anchored to end-of-string. Matches the tail check
// inside `looksLikeFile` so the two stay in sync.
const HAS_EXT_REGEX = /\.[A-Za-z0-9]{1,8}$/;

function parseIntOpt(s: string | undefined): number | undefined {
  if (s === undefined) {
    return undefined;
  }
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function looksLikeFile(p: string): boolean {
  if (p.length === 0) {
    return false;
  }
  // Trailing path separator → directory indicator (e.g. `src/providers/`).
  // Files don't end in a slash; refusing to highlight these saves the user
  // from clicking and getting a "File not found" toast they can't act on.
  if (/[/\\]$/.test(p)) {
    return false;
  }
  // Reject `<identifier>=<value>` shapes such as `Version=1.2.3.4` or
  // `LOG_LEVEL=info`. The broadened body charset (design D3) now accepts `=`,
  // and without this guard a key/value would slip past the version-string
  // filter once it picks up an `.<ext>` looking tail.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(p)) {
    return false;
  }
  // Reject npm-style `<package>@<version>` shapes (e.g. `react@18.2.0`).
  // Anchored at end-of-string so patch-file names with a real extension
  // survive (`react@18.2.0.patch`, `lodash@4.17.21.diff`). The `@\d` anchor
  // avoids matching `user@host.com` (email noise, harmless) or `foo@bar.baz`
  // (could be a real path).
  if (/^[A-Za-z_][A-Za-z0-9_-]*@\d+(?:\.\d+)*$/.test(p)) {
    return false;
  }
  if (/[/\\]/.test(p)) {
    return true;
  }
  // Reject version-like patterns (e.g. 1.2.3, v1.2.3) — common terminal noise.
  if (/^[A-Za-z]?\d+(?:\.\d+)+$/.test(p)) {
    return false;
  }
  const m = p.match(/^(.+)\.([A-Za-z0-9]{1,8})$/);
  if (!m) {
    return false;
  }
  return /[A-Za-z]/.test(m[1]);
}

// Path body broadened to VS Code parity (see `design.md` D3 +
// terminalLinkParsing.ts:212 upstream). Includes any non-whitespace,
// non-delimiter character — accepts `#`, `&`, `=`, `%`, `:`, non-ASCII
// letters. Parens deliberately excluded from the bare body to avoid clashing
// with the `(LINE,COL)` suffix grammar; users with paren-containing paths
// (e.g. `/Users/Bob (work)/...`) must use the quoted form. Backslash is
// naturally included on both platforms — POSIX terminals occasionally surface
// Windows-style paths (pasted, cat'd from log files) and clicking them is
// what the user expects.
const PATH_BODY = String.raw`[^\s'"<>(){}\[\]|]+`;

function buildSuffixedRegex(platform: "posix" | "win32"): RegExp {
  const drive = platform === "win32" ? "(?:[A-Za-z]:)?" : "";
  // Suffix variants accepted:
  //   :LINE, :LINE:COL, :LINE.COL  — most common compiler output
  //   :LINE-LINE                   — line range (ripgrep multi-line, agent output)
  //   (LINE), (LINE,COL), [LINE], [LINE:COL]
  //   #LINE, #LLINE                — GitHub-style permalink fragment (#L42 or #42)
  //   #L?LINE-L?LINE               — GitHub line range (#L42-L43)
  // When a range is present, only the FIRST line is captured (popup.focusLine
  // scrolls to the start of the range; selecting the whole range is a
  // separate feature). The optional `-LINE` is consumed by the regex so the
  // matched text underlines the entire suffix instead of leaving the tail
  // unlinked.
  const suffix = String.raw`(?::(?<row1>\d+)(?:[:.](?<col1>\d+))?(?:-\d+)?|[(\[](?<row2>\d+)(?:[,:]\s*(?<col2>\d+))?[)\]]|#L?(?<row3>\d+)(?:-L?\d+)?)`;
  const boundary = String.raw`(?<=^|[\s'"<({\[])`;
  // SUFFIXED regex uses a LAZY body — the broadened charset now includes `:`,
  // and a greedy body would eat `:LINE` and leave only `:COL`. Lazy lets the
  // explicit suffix grammar bite at the first viable position. Windows drive
  // (`C:`) still matches because the non-capturing `(?:[A-Za-z]:)?` is
  // anchored at the start of the path group, before the lazy body.
  const lazyBody = `${PATH_BODY.slice(0, -1)}+?`;
  return new RegExp(`${boundary}(?<path>${drive}${lazyBody})${suffix}`, "g");
}

function buildBareRegex(platform: "posix" | "win32"): RegExp {
  const drive = platform === "win32" ? "(?:[A-Za-z]:)?" : "";
  const boundary = String.raw`(?<=^|[\s'"<({\[])`;
  const after = String.raw`(?=$|[\s'"<>)}\],;])`;
  return new RegExp(`${boundary}(?<path>${drive}${PATH_BODY})${after}`, "g");
}

// Python: File "x.py", line 42, column 7 — or — "x.py", line 42
const PYTHON_VERBOSE_RE =
  /(?:File\s)?"(?<path>[^"\n]+)",\s+lines?\s+(?<row>\d+)(?:,\s+(?:columns?|col(?:umn)?)\s+(?<col>\d+))?/g;

// Python compact: "x.py":42 or "x.py":42:7
const PYTHON_COLON_RE = /"(?<path>[^"\n]+)":(?<row>\d+)(?::(?<col>\d+))?/g;

/**
 * Claude CLI / agent-narration pattern used in tool-call summaries:
 *   `Read(/path/to/file.ts · lines 180-299)`
 *   `Edit(/path/foo.ts · line 42)`
 * The path runs until whitespace, then a middle-dot (U+00B7) separator, then
 * the literal word "line" or "lines", then a number (or N-M range).
 *
 * The path body excludes `)` so the trailing close-paren in `Read(...)` doesn't
 * get pulled into the match.
 */
const CLAUDE_LINES_RE = /(?<path>[^\s'"<>(){}[\]|]+)\s+·\s+lines?\s+(?<row>\d+)(?:-\d+)?/g;

const SUFFIXED_POSIX = buildSuffixedRegex("posix");
const SUFFIXED_WIN32 = buildSuffixedRegex("win32");
const BARE_POSIX = buildBareRegex("posix");
const BARE_WIN32 = buildBareRegex("win32");

/**
 * Detect file-path candidates in a single line of terminal text.
 *
 * Returns at most `MAX_RESULTS` (=10) results, in line-position order.
 * Returns `[]` immediately for lines longer than `MAX_LINE_LENGTH` (=2000).
 * Candidates that match a URL scheme are rejected; candidates that don't
 * contain a path separator or a valid extension are rejected.
 */
export function detectFilePathLinks(lineText: string, platform: "posix" | "win32"): ParsedFilePathLink[] {
  if (lineText.length > MAX_LINE_LENGTH) {
    return [];
  }

  const raw: ParsedFilePathLink[] = [];

  collectSuffixed(platform === "win32" ? SUFFIXED_WIN32 : SUFFIXED_POSIX, lineText, raw);
  collectBare(platform === "win32" ? BARE_WIN32 : BARE_POSIX, lineText, raw);
  collectPython(PYTHON_VERBOSE_RE, lineText, raw);
  collectPython(PYTHON_COLON_RE, lineText, raw);
  collectPython(CLAUDE_LINES_RE, lineText, raw);

  const deduped = dedupOnOverlap(raw);
  deduped.sort((a, b) => a.index - b.index);
  return deduped.slice(0, MAX_RESULTS);
}

function pushCandidate(
  out: ParsedFilePathLink[],
  text: string,
  index: number,
  path: string,
  line: number | undefined,
  col: number | undefined,
  trimTrailingPunctOnBare: boolean,
): void {
  if (URL_SCHEME_REGEX.test(text)) {
    return;
  }
  let finalPath = path;
  let finalText = text;
  if (trimTrailingPunctOnBare) {
    const trimmed = finalPath.replace(TRAIL_PUNCT_REGEX, "");
    const lost = finalPath.length - trimmed.length;
    if (lost > 0) {
      finalPath = trimmed;
      finalText = finalText.slice(0, finalText.length - lost);
    }
  }
  // AI-tool `@filepath` mention prefix — strip for resolution, keep in
  // underlined text. Convention shared by Claude Code (`@docs/foo.md`),
  // OpenAI Codex (`@`-fuzzy file picker), OpenCode, Cursor, Cline
  // (`@/path/to/file`), Zed (`@` → `file://` link). The `@` is a UI affordance
  // that introduces a file reference; the resolver should see the bare path.
  //
  // Gate: require BOTH a path separator AND a recognizable extension on the
  // stripped path. Without this, npm scoped names (`@scope/pkg`) and social
  // mentions (`@username`) would slip past `looksLikeFile`'s `/` check or its
  // extension check alone and become clickable underlines that resolve to
  // nothing. Boundary precedes the `@` already (suffixed/bare regex enforces
  // `^|[\s'"<({\[]` before the path), so mid-token `@` like `user@host.com`
  // never starts a match and is unaffected.
  if (finalPath.startsWith("@") && finalPath.length > 1) {
    const stripped = finalPath.slice(1);
    if (!/[/\\]/.test(stripped) || !HAS_EXT_REGEX.test(stripped)) {
      return;
    }
    finalPath = stripped;
    // finalText keeps the leading `@` so the on-screen underline covers the
    // full mention as the user typed it.
  }
  if (!looksLikeFile(finalPath)) {
    return;
  }
  out.push({ text: finalText, index, path: finalPath, line, col });
}

function collectSuffixed(re: RegExp, line: string, out: ParsedFilePathLink[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const g = m.groups!;
    pushCandidate(
      out,
      m[0],
      m.index,
      g.path,
      parseIntOpt(g.row1 ?? g.row2 ?? g.row3),
      parseIntOpt(g.col1 ?? g.col2),
      false,
    );
  }
}

function collectBare(re: RegExp, line: string, out: ParsedFilePathLink[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const path = m.groups!.path;
    pushCandidate(out, m[0], m.index, path, undefined, undefined, true);
  }
}

function collectPython(re: RegExp, line: string, out: ParsedFilePathLink[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const g = m.groups!;
    pushCandidate(out, m[0], m.index, g.path, parseIntOpt(g.row), parseIntOpt(g.col), false);
  }
}

function dedupOnOverlap(list: ParsedFilePathLink[]): ParsedFilePathLink[] {
  // Longer-text wins: sort desc, keep first occurrence in any overlapping range.
  const sorted = [...list].sort((a, b) => b.text.length - a.text.length);
  const kept: ParsedFilePathLink[] = [];
  for (const item of sorted) {
    const end = item.index + item.text.length;
    const overlap = kept.some((k) => {
      const kEnd = k.index + k.text.length;
      return item.index < kEnd && end > k.index;
    });
    if (!overlap) {
      kept.push(item);
    }
  }
  return kept;
}
