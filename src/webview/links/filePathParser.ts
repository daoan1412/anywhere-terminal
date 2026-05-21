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

const URL_SCHEME_REGEX = /^(?:https?|file|ftp|ssh|git|mailto):/i;
const TRAIL_PUNCT_REGEX = /[.,;:!?]+$/;

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

function buildSuffixedRegex(platform: "posix" | "win32"): RegExp {
  const pathBody = platform === "win32" ? String.raw`[\w./\\@~+\-]+` : String.raw`[\w./@~+\-]+`;
  const drive = platform === "win32" ? "(?:[A-Za-z]:)?" : "";
  const suffix = String.raw`(?::(?<row1>\d+)(?:[:.](?<col1>\d+))?|[(\[](?<row2>\d+)(?:[,:]\s*(?<col2>\d+))?[)\]])`;
  const boundary = String.raw`(?<=^|[\s'"<({\[])`;
  return new RegExp(`${boundary}(?<path>${drive}${pathBody})${suffix}`, "g");
}

function buildBareRegex(platform: "posix" | "win32"): RegExp {
  const pathBody = platform === "win32" ? String.raw`[\w./\\@~+\-]+` : String.raw`[\w./@~+\-]+`;
  const drive = platform === "win32" ? "(?:[A-Za-z]:)?" : "";
  const boundary = String.raw`(?<=^|[\s'"<({\[])`;
  const after = String.raw`(?=$|[\s'"<>)}\],;])`;
  return new RegExp(`${boundary}(?<path>${drive}${pathBody})${after}`, "g");
}

// Python: File "x.py", line 42, column 7 — or — "x.py", line 42
const PYTHON_VERBOSE_RE =
  /(?:File\s)?"(?<path>[^"\n]+)",\s+lines?\s+(?<row>\d+)(?:,\s+(?:columns?|col(?:umn)?)\s+(?<col>\d+))?/g;

// Python compact: "x.py":42 or "x.py":42:7
const PYTHON_COLON_RE = /"(?<path>[^"\n]+)":(?<row>\d+)(?::(?<col>\d+))?/g;

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
    pushCandidate(out, m[0], m.index, g.path, parseIntOpt(g.row1 ?? g.row2), parseIntOpt(g.col1 ?? g.col2), false);
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
