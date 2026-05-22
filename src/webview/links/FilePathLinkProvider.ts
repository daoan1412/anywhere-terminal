// src/webview/links/FilePathLinkProvider.ts — xterm.js link provider for file paths.
//
// Detects file paths in terminal buffer lines (via filePathParser) and exposes
// them to xterm.js as clickable, underlined links. Activation sends an
// `openFile` message to the extension host for resolution + opening. The
// controller is also notified per link so it can install hover preview
// callbacks (see `HoverPreviewController`).
//
// See: asimov/specs/terminal-clickable-file-paths/spec.md
// See: asimov/changes/add-clickable-file-paths/design.md D1, D2, D5, D10, D11
// See: asimov/changes/add-hover-file-preview/design.md "Architecture"

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { OpenFileMessage, WebViewToExtensionMessage } from "../../types/messages";
import { detectFilePathLinks } from "./filePathParser";
import type { HoverPreviewController } from "./HoverPreviewController";

/**
 * Temporary debug logging for wrap-aware link detection. Toggle via the
 * webview console: `window.__AT_DEBUG_WRAP = true` (then hover again).
 * Off by default to keep production noise-free.
 */
function wrapDebug(): boolean {
  return Boolean((globalThis as { __AT_DEBUG_WRAP?: boolean }).__AT_DEBUG_WRAP);
}
function wlog(...args: unknown[]): void {
  if (wrapDebug()) {
    console.log("[AT/wrap]", ...args);
  }
}

/** Dependencies for FilePathLinkProvider. */
export interface FilePathLinkProviderDeps {
  terminal: Terminal;
  sessionId: string;
  postMessage: (msg: WebViewToExtensionMessage) => void;
  platform: "posix" | "win32";
  /**
   * Optional hover-preview controller. When present, `provideLinks` calls
   * `controller.attachHover(link)` per produced link so hover triggers the
   * popup; `dispose()` propagates to the controller.
   */
  hoverController?: HoverPreviewController;
}

/**
 * xterm.js link provider that detects file paths and dispatches `openFile`
 * messages on activation. Underlines are applied via xterm's built-in
 * link-decoration support.
 */
export class FilePathLinkProvider implements ILinkProvider {
  private readonly terminal: Terminal;
  private readonly sessionId: string;
  private readonly postMessage: (msg: WebViewToExtensionMessage) => void;
  private readonly platform: "posix" | "win32";
  private readonly hoverController: HoverPreviewController | undefined;
  private disposed = false;

  constructor(deps: FilePathLinkProviderDeps) {
    this.terminal = deps.terminal;
    this.sessionId = deps.sessionId;
    this.postMessage = deps.postMessage;
    this.platform = deps.platform;
    this.hoverController = deps.hoverController;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    // xterm.js convention: provideLinks receives a 1-based row number, but
    // IBuffer.getLine() expects a 0-based index. Without the offset we read
    // the line BELOW the one the user is hovering — the underline ends up
    // on the wrong row AND the activated path comes from a different line
    // (manifesting as both "highlight off by one" and "File not found").
    const buf = this.terminal.buffer.active;
    const requestedIdx = bufferLineNumber - 1;

    // Soft-wrap awareness: xterm marks continuation rows of a wrapped logical
    // line with `isWrapped: true`. Without this, hovering the tail half of a
    // wrapped path matches only the visible substring (e.g. "rPreviewPopup.ts"
    // instead of "/Users/.../HoverPreviewPopup.ts") and the resolver returns
    // `not-found`. Walk back to find the logical start, then forward to
    // collect every continuation row.
    //
    // FALLBACK heuristic: some applications emit their OWN line break + indent
    // (claude-code agent output, codex CLI tree-prefix, ripgrep, eslint, etc.)
    // which is NOT a true xterm wrap — `isWrapped` stays false. Two distinct
    // continuation shapes exist and require DIFFERENT join semantics:
    //
    //   "in-path": the path token itself was split mid-character (Claude's
    //     `Update(/.../wo` + indent + `rkflow.md)`). To rebuild the path we
    //     STRIP trailing padding from row 1 AND leading indent from row 2.
    //
    //   "marker": a structural separator falls between rows — e.g. Claude's
    //     `Read(<path> · lines N-M)` wrapping at the space before `·`. The
    //     parser's regex (`\s+·\s+lines?`) REQUIRES whitespace at the seam,
    //     so we must PRESERVE the trailing space on row 1 (and any leading
    //     whitespace on row 2 that aligns the continuation visually).
    //
    // Padding state of row 1 is NOT consulted: xterm always pads cells past
    // an app-emitted `\n` with default spaces, so `prevRaw.length ===
    // prevTrim.length` only holds when row 1 happens to fill terminal width
    // exactly — rare for Claude/Codex/Ink-style TUIs that wrap on their own
    // grid (not on terminal width).
    type ContinuationKind = "none" | "marker" | "in-path";
    const continuationKind = (prevRaw: string, curRaw: string): ContinuationKind => {
      const prevTrim = prevRaw.trimEnd();
      const curTrim = curRaw.trimStart();
      if (prevTrim.length === 0 || curTrim.length === 0) {
        return "none";
      }

      // ── Claude CLI tool-call narration MARKER continuations ──────────
      // The Read(<path> · lines N-M) format can wrap at any token boundary.
      // Each variant below identifies an unmistakable continuation marker
      // on row 2 — these win regardless of how row 1 ended (whitespace
      // padding or not). Whole-pattern detection still happens at the
      // parser stage; this just decides whether to JOIN the rows.
      //   wrap between path and `·`     →  row 2 starts with `· line(s) `
      //   wrap between `·` and `lines`  →  row 2 starts with `line(s) <digit>`
      //   wrap between `lines` and N    →  row 2 starts with digit AND row 1
      //                                    ends with the word `line(s)`
      if (/^·\s+lines?\b/.test(curTrim)) {
        return "marker";
      }
      if (/^lines?\s+\d/.test(curTrim)) {
        return "marker";
      }
      if (/^\d/.test(curTrim) && /\blines?$/i.test(prevTrim)) {
        return "marker";
      }

      // ── Boundary checks for IN-PATH wrap: both ends must be path-safe ─
      const lastChar = prevTrim.charAt(prevTrim.length - 1);
      if (!/[A-Za-z0-9._\-/\\]/.test(lastChar)) {
        return "none";
      }
      const firstChar = curTrim.charAt(0);
      if (!/[A-Za-z0-9._\-/\\]/.test(firstChar)) {
        return "none";
      }

      // ── Indent gate: real in-path continuations ARE indented ─────────
      // Real-world AI CLI wraps (Claude Code's Ink layout, Codex's
      // `subsequent_indent="    "`, aider's rich.Columns) always indent the
      // continuation row to align with the wrap point. A row that starts
      // flush at column 0 with a path-safe char is almost always a NEW
      // logical line: `find /`, `cat /etc/hosts.d/*`, compiler errors
      // listing files, etc. Without this gate, two adjacent absolute paths
      //   /tmp/foo.ts
      //   /tmp/bar.ts
      // would join into Frankenstein `/tmp/foo.ts/tmp/bar.ts`. xterm
      // soft-wraps land here too but they short-circuit earlier via
      // `isWrapped`, so this gate only affects the heuristic branch.
      if (curRaw === curTrim) {
        return "none";
      }

      // ── Last-token analysis: focus on the trailing non-whitespace run ─
      // Scanning the WHOLE row for `looksAbsolute` triggered false-positives
      // on shell prompts (`user@host:/cwd$` filling 80 cols followed by an
      // unrelated `-rw-r--r--` row — the `/cwd` token matched). Restricting
      // the analysis to the LAST contiguous token forces the decision to
      // hinge on what's actually about to wrap, not on anything earlier in
      // the row.
      const lastTokenMatch = prevTrim.match(/\S+$/);
      const lastToken = lastTokenMatch ? lastTokenMatch[0] : "";
      if (lastToken.length === 0) {
        return "none";
      }
      // (a) Last token begins with a recognized tool-call prefix:
      //     `Update(/path…`, `Read(/path…`, `Edit(/path…`, etc.
      const lastTokenIsToolCall = /^(?:Read|Edit|Write|Update|Search|Grep|Glob|MultiEdit|NotebookEdit|Bash)\s*\(/.test(
        lastToken,
      );
      // (b) Last token contains an absolute-path root after a boundary char
      //     (start-of-token, or one of `(`/`[`/`{` so that `Update(/path`,
      //     `[/path`, `{/path` are all accepted). The Codex `  └ /path`
      //     tree-prefix lands here because the prev-row trim leaves `└` as
      //     a separator and the lastToken is just `/path…`.
      const lastTokenLooksAbsolute = /(?:^|[\s'"<({[])(?:[A-Za-z]:[\\/]|\/|~\/)/.test(lastToken);
      if (lastTokenIsToolCall || lastTokenLooksAbsolute) {
        return "in-path";
      }
      return "none";
    };

    // Round-2 W6: cap how far the wrap walk can travel before we concatenate
    // (and how big the joined string can get). A dense block of full-width
    // hard-wrapped output should not allocate O(scrollback) text per hover.
    // These limits comfortably cover any realistic file-path-bearing wrap
    // (the longest valid path is bounded by `previewValidation.MAX_PREVIEW_PATH_LENGTH`
    // = 4096, but most wrap into 2-3 rows on an 80-col terminal).
    const MAX_WRAP_ROWS = 8;
    const MAX_WRAP_CHARS = 3000;

    let startIdx = requestedIdx;
    let backSteps = 0;
    while (startIdx > 0 && backSteps < MAX_WRAP_ROWS) {
      const ln = buf.getLine(startIdx);
      if (!ln) {
        break;
      }
      const prev = buf.getLine(startIdx - 1);
      if (!prev) {
        break;
      }
      const isXtermWrap = Boolean(ln.isWrapped);
      const prevText = prev.translateToString(false);
      const curText = ln.translateToString(false);
      const heuristicKind = continuationKind(prevText, curText);
      wlog("back", { startIdx, prevLen: prevText.length, isXtermWrap, heuristicKind });
      if (!isXtermWrap && heuristicKind === "none") {
        break;
      }
      startIdx--;
      backSteps++;
    }

    // rows[k]: { text, offset } where offset is the start index of this row's
    // text inside the concatenated logical line. Trim choices depend on the
    // CONNECTION between consecutive rows:
    //
    //   "xterm-wrap": cells are filled by xterm (no padding to strip).
    //     Preserve everything; column math depends on full-width cells.
    //
    //   "in-path": path token split mid-character. Strip TRAILING padding
    //     from prev row AND LEADING indent from cur row, so the joined text
    //     reads as one contiguous path token. `indentDropped` is stashed for
    //     the per-row link range shift.
    //
    //   "marker": structural separator at the seam (`· lines`, `lines N`,
    //     digit after `lines`). Parser regex REQUIRES whitespace at the seam
    //     (`\s+·\s+lines?`), so DO NOT trim — preserve trailing space on
    //     prev row and any leading whitespace on cur row.
    //
    // First pass: collect rows with the connection type that brought them in.
    type Connection = "first" | "xterm-wrap" | "marker" | "in-path";
    type CollectedRow = {
      rawText: string;
      conn: Connection;
      bufferLineNumber: number;
    };
    const collected: CollectedRow[] = [];
    {
      let i = startIdx;
      let prevRowRaw = "";
      let totalChars = 0;
      while (collected.length < MAX_WRAP_ROWS && totalChars < MAX_WRAP_CHARS) {
        const ln = buf.getLine(i);
        if (!ln) {
          break;
        }
        const rawText = ln.translateToString(false);
        const isXtermWrap = Boolean(ln.isWrapped);
        let conn: Connection;
        if (i === startIdx) {
          conn = "first";
        } else if (isXtermWrap) {
          conn = "xterm-wrap";
        } else {
          const kind = continuationKind(prevRowRaw, rawText);
          wlog("fwd", { i, kind, rawText: rawText.slice(0, 80) });
          if (kind === "none") {
            break;
          }
          conn = kind;
        }
        collected.push({ rawText, conn, bufferLineNumber: i + 1 });
        totalChars += rawText.length;
        prevRowRaw = rawText;
        i++;
      }
    }

    // Second pass: derive `text` per row with conn-aware trims.
    const rows: { text: string; offset: number; bufferLineNumber: number; indentDropped: number }[] = [];
    let offset = 0;
    for (let k = 0; k < collected.length; k++) {
      const cur = collected[k];
      const next = collected[k + 1];
      // Leading trim ONLY for in-path continuations (strip indent so the path
      // token is contiguous). Marker continuations need the leading whitespace
      // preserved so `\s+·\s+lines?` matches at the seam.
      const leadingTrim = cur.conn === "in-path";
      const afterLeading = leadingTrim ? cur.rawText.trimStart() : cur.rawText;
      const indentDropped = leadingTrim ? cur.rawText.length - afterLeading.length : 0;
      // Trailing trim ONLY when next row is an in-path continuation (strip
      // padding so the path token concatenates without a gap). For xterm-wrap
      // the cells are filled, and for marker continuations the trailing space
      // is part of the regex anchor.
      const text = next?.conn === "in-path" ? afterLeading.trimEnd() : afterLeading;
      rows.push({ text, offset, bufferLineNumber: cur.bufferLineNumber, indentDropped });
      offset += text.length;
    }

    wlog(
      "collected rows",
      rows.map((r, k) => ({
        ln: r.bufferLineNumber,
        conn: collected[k]?.conn,
        indentDropped: r.indentDropped,
        preview: r.text.slice(0, 80),
      })),
    );

    if (rows.length === 0) {
      callback(undefined);
      return;
    }

    const fullText = rows.map((r) => r.text).join("");
    if (fullText.length === 0) {
      callback(undefined);
      return;
    }

    wlog("fullText", fullText.length, JSON.stringify(fullText.slice(0, 200)));

    const parsed = detectFilePathLinks(fullText, this.platform);
    wlog("parsed", parsed);
    if (parsed.length === 0) {
      callback(undefined);
      return;
    }

    const links: ILink[] = [];
    for (const p of parsed) {
      const matchStart = p.index;
      const matchEnd = p.index + p.text.length - 1; // inclusive
      // A wrapped match spans multiple rows; xterm's ILink.range must be on a
      // single row (start.y === end.y). We emit ONE link per row the match
      // overlaps, but only for the requested `bufferLineNumber` (xterm calls
      // provideLinks per-row, so this method only needs to produce links for
      // THIS row). Each segment shares the same activate/hover callbacks, so
      // the underline + click + popup all work whether the user hovers the
      // start or the continuation rows.
      for (const row of rows) {
        if (row.bufferLineNumber !== bufferLineNumber) {
          continue;
        }
        const rowStart = row.offset;
        const rowEnd = row.offset + row.text.length - 1; // inclusive
        if (matchEnd < rowStart || matchStart > rowEnd) {
          continue; // no overlap on this row
        }
        const segStartIdx = Math.max(matchStart, rowStart) - rowStart; // 0-based col within trimmed row
        const segEndIdx = Math.min(matchEnd, rowEnd) - rowStart; // 0-based col within trimmed row, inclusive
        // Heuristic-wrap rows had their leading indent stripped before joining;
        // shift the segment back by that many columns so the underline lines
        // up with the actual characters on screen.
        const indentDropped = row.indentDropped;
        // xterm.js buffer ranges are 1-based; end.x is INCLUSIVE of the last char (design.md D11).
        const range = {
          start: { x: segStartIdx + indentDropped + 1, y: bufferLineNumber },
          end: { x: segEndIdx + indentDropped + 1, y: bufferLineNumber },
        };
        wlog("emit link", {
          path: p.path,
          row: bufferLineNumber,
          matchStart,
          matchEnd,
          rowStart,
          rowEnd,
          indentDropped,
          range,
        });
        const link: ILink = {
          // `text` carries the FULL matched string even when this segment only
          // covers a fragment — used by xterm's hover label fallback AND read
          // by HoverPreviewController.linkKey as the link identity.
          text: p.text,
          range,
          decorations: { underline: true, pointerCursor: true },
          activate: (event) => {
            event.preventDefault();
            const msg: OpenFileMessage = {
              type: "openFile",
              path: p.path,
              sessionId: this.sessionId,
            };
            if (p.line !== undefined) {
              msg.line = p.line;
            }
            if (p.col !== undefined) {
              msg.col = p.col;
            }
            this.postMessage(msg);
          },
        };
        // Install hover-preview callbacks BEFORE returning the link — the
        // controller wraps any existing hover/leave on the link. We pass the
        // raw `p.path` (sans line/col suffix) explicitly because `link.text`
        // is the FULL matched text (e.g. "src/foo.ts:42") which the host's
        // path resolver cannot consume. The parsed `line` is forwarded so the
        // popup can scroll-to-line on display.
        if (this.hoverController && !this.disposed) {
          this.hoverController.attachHover(link, p.path, p.line);
        }
        links.push(link);
      }
    }

    callback(links.length > 0 ? links : undefined);
  }

  /**
   * Dispose — invoked when the terminal is torn down. Propagates to the
   * hover controller so its DOM listeners detach and any visible popup is
   * unmounted. Idempotent.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.hoverController?.dispose();
    } catch {
      // Best-effort.
    }
  }
}
