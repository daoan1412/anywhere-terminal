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
    // (claude-code agent output, ripgrep, eslint, etc.) which is NOT a true
    // xterm wrap — `isWrapped` stays false. We additionally treat a row as a
    // continuation when its trimmed text concatenated with the previous row's
    // trimmed text would form a single token without separating whitespace
    // (i.e. the previous row does NOT end with whitespace AND the current row
    // starts with non-separator chars). Concatenation strips the indent.
    const isPathContinuation = (prevRaw: string, curRaw: string): boolean => {
      const prevTrim = prevRaw.trimEnd();
      const curTrim = curRaw.trimStart();
      if (prevTrim.length === 0 || curTrim.length === 0) {
        return false;
      }

      // ── Claude CLI tool-call narration continuations ──────────────────
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
        return true;
      }
      if (/^lines?\s+\d/.test(curTrim)) {
        return true;
      }
      if (/^\d/.test(curTrim) && /\blines?$/i.test(prevTrim)) {
        return true;
      }

      // ── In-path wrap (Update(/long/path...) split mid-token) ──────────
      // Round-2 W6: restrict this STRUCTURAL heuristic to rows that look
      // like a path-bearing context. Without the gate, any two adjacent
      // rows where row 1 exactly fills cols and both ends are path chars
      // get joined — including unrelated `ls -la` output where row 1
      // happens to be 80 chars wide. The gate accepts EITHER:
      //   (a) Row 1 begins with a recognized tool-call prefix
      //       (Claude CLI, ripgrep -uu, fd, etc.), OR
      //   (b) The joined text contains an absolute-path-rooted token
      //       (`/`-leading or `~/`-leading or `C:\`-style drive letter).
      // (b) is checked by testing whether row 1 (anywhere after a
      // boundary char) already contains such a token.
      const lastChar = prevTrim.charAt(prevTrim.length - 1);
      if (!/[A-Za-z0-9._\-/\\]/.test(lastChar)) {
        return false;
      }
      if (prevRaw.length !== prevTrim.length) {
        return false;
      }
      const firstChar = curTrim.charAt(0);
      if (!/[A-Za-z0-9._\-/\\]/.test(firstChar)) {
        return false;
      }
      const looksToolCall = /(?:^|\s)(?:Read|Edit|Write|Update|Search|Grep|Glob|MultiEdit|NotebookEdit|Bash)\s*\(/.test(
        prevTrim,
      );
      const looksAbsolute = /(?:^|[\s'"<({[])(?:[A-Za-z]:[\\/]|\/|~\/)/.test(prevTrim);
      return looksToolCall || looksAbsolute;
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
      const isHeuristicWrap = isPathContinuation(prevText, curText);
      wlog("back", { startIdx, prevLen: prevText.length, isXtermWrap, isHeuristicWrap });
      if (!isXtermWrap && !isHeuristicWrap) {
        break;
      }
      startIdx--;
      backSteps++;
    }

    // rows[k]: { text, offset } where offset is the start index of this row's
    // text inside the concatenated logical line. For TRUE xterm soft-wrap rows
    // we use the raw text (padding preserved) so column math is correct. For
    // HEURISTIC continuations (application-emitted newline + indent) we strip
    // the leading whitespace so the joined text reads as one path token.
    const rows: { text: string; offset: number; bufferLineNumber: number; isXtermWrap: boolean }[] = [];
    let offset = 0;
    let i = startIdx;
    let prevRowRaw = "";
    while (rows.length < MAX_WRAP_ROWS && offset < MAX_WRAP_CHARS) {
      const ln = buf.getLine(i);
      if (!ln) {
        break;
      }
      const rawText = ln.translateToString(false);
      const isXtermWrap = Boolean(ln.isWrapped);
      if (i > startIdx) {
        const isHeuristicWrap = isPathContinuation(prevRowRaw, rawText);
        wlog("fwd", { i, isXtermWrap, isHeuristicWrap, rawText: rawText.slice(0, 80) });
        if (!isXtermWrap && !isHeuristicWrap) {
          break;
        }
      }
      // For heuristic continuations, drop the leading indent so the joined
      // path is contiguous. The lost columns are accounted for below — links
      // emitted for THIS row must offset segStartIdx back by the trimmed amount.
      const useText = i > startIdx && !isXtermWrap ? rawText.trimStart() : rawText;
      const indentDropped = i > startIdx && !isXtermWrap ? rawText.length - useText.length : 0;
      rows.push({
        text: useText,
        offset,
        bufferLineNumber: i + 1,
        isXtermWrap,
      });
      // Stash indent-drop count on the row for the later col mapping.
      (rows[rows.length - 1] as { indentDropped?: number }).indentDropped = indentDropped;
      offset += useText.length;
      prevRowRaw = rawText;
      i++;
    }

    wlog(
      "collected rows",
      rows.map((r) => ({
        ln: r.bufferLineNumber,
        isXtermWrap: r.isXtermWrap,
        indentDropped: (r as { indentDropped?: number }).indentDropped,
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
        const indentDropped = (row as { indentDropped?: number }).indentDropped ?? 0;
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
