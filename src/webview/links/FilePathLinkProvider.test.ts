// src/webview/links/FilePathLinkProvider.test.ts — Unit tests for FilePathLinkProvider.

import type { ILink, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import type { WebViewToExtensionMessage } from "../../types/messages";
import { FilePathLinkProvider } from "./FilePathLinkProvider";

/**
 * Build a Terminal stub whose buffer.active.getLine returns a single line at
 * 0-based index 0. Tests then call provideLinks(1, ...) to match xterm.js's
 * 1-based bufferLineNumber convention; the provider subtracts 1 internally.
 */
function makeTerminalStub(line: string): Terminal {
  return {
    buffer: {
      active: {
        getLine: (n: number) =>
          n === 0
            ? {
                isWrapped: false,
                translateToString: (_trimRight?: boolean) => line,
              }
            : undefined,
      },
    },
  } as unknown as Terminal;
}

/**
 * Build a stub representing a logical line soft-wrapped across `lines` rows.
 * Each row's `isWrapped` flag can be customized via `wrappedFlags`. When
 * `wrappedFlags` is omitted, continuation rows (index > 0) default to true —
 * simulating a true xterm soft-wrap.
 *
 * For application-emitted line-break tests (claude/agent output style), pass
 * `wrappedFlags: [false, false]` so the provider must rely on the indent /
 * full-width heuristic to detect the continuation.
 */
function makeWrappedTerminalStub(rowTexts: string[], wrappedFlags?: boolean[]): Terminal {
  return {
    buffer: {
      active: {
        getLine: (n: number) => {
          if (n < 0 || n >= rowTexts.length) {
            return undefined;
          }
          const isWrapped = wrappedFlags ? (wrappedFlags[n] ?? false) : n > 0;
          return {
            isWrapped,
            translateToString: (_trimRight?: boolean) => rowTexts[n],
          };
        },
      },
    },
  } as unknown as Terminal;
}

function collect(provider: FilePathLinkProvider, lineNumber = 1): ILink[] | undefined {
  let captured: ILink[] | undefined;
  provider.provideLinks(lineNumber, (links) => {
    captured = links;
  });
  return captured;
}

describe("FilePathLinkProvider: hover controller wiring (task 3_5)", () => {
  it("calls controller.attachHover(link, p.path) once per produced link, passing the raw path (not link.text)", () => {
    const terminal = makeTerminalStub("at src/foo.ts:42 fail");
    const attachHover = vi.fn();
    const dispose = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage: vi.fn(),
      platform: "posix",
      hoverController: { attachHover, dispose, onMessage: vi.fn(), dismiss: vi.fn() } as never,
    });
    const links = collect(provider);
    expect(links).toHaveLength(1);
    expect(attachHover).toHaveBeenCalledTimes(1);
    const [linkArg, pathArg] = attachHover.mock.calls[0];
    // link arg should be the same ref the callback received.
    expect(linkArg).toBe(links?.[0]);
    // path arg is the SANITIZED path without the line/col suffix.
    expect(pathArg).toBe("src/foo.ts");
    // link.text remains the full matched string.
    expect(linkArg.text).toBe("src/foo.ts:42");
  });

  it("provider.dispose() propagates to controller.dispose()", () => {
    const terminal = makeTerminalStub("anything");
    const dispose = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage: vi.fn(),
      platform: "posix",
      hoverController: { attachHover: vi.fn(), dispose, onMessage: vi.fn(), dismiss: vi.fn() } as never,
    });
    provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    // Idempotent.
    provider.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("after dispose(), provideLinks does NOT attach hovers (controller is inert)", () => {
    const terminal = makeTerminalStub("at src/foo.ts:42 fail");
    const attachHover = vi.fn();
    const dispose = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage: vi.fn(),
      platform: "posix",
      hoverController: { attachHover, dispose, onMessage: vi.fn(), dismiss: vi.fn() } as never,
    });
    provider.dispose();
    collect(provider);
    expect(attachHover).not.toHaveBeenCalled();
  });
});

describe("FilePathLinkProvider.provideLinks", () => {
  it("calls callback(undefined) for a non-matching line", () => {
    const terminal = makeTerminalStub("just some prose without a path");
    const postMessage = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    expect(collect(provider)).toBeUndefined();
  });

  it("calls callback(undefined) for an empty line", () => {
    const terminal = makeTerminalStub("");
    const postMessage = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    expect(collect(provider)).toBeUndefined();
  });

  it("calls callback(undefined) when buffer.active.getLine returns undefined", () => {
    const terminal = makeTerminalStub("anything");
    const postMessage = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    // bufferLineNumber=99 → getLine(98) → undefined (stub only returns line at 0).
    expect(collect(provider, 99)).toBeUndefined();
  });

  it("converts xterm's 1-based bufferLineNumber to 0-based for getLine, sets range.y to the original 1-based value", () => {
    // Regression test for the off-by-one that caused both: (a) underline
    // rendered on the wrong row, and (b) path parsed from the line below
    // the one the user actually hovered (manifesting as "File not found").
    const seen: number[] = [];
    const terminal = {
      buffer: {
        active: {
          getLine: (n: number) => {
            seen.push(n);
            // The "real" content is at row 5 (1-based) = index 4 (0-based).
            if (n === 4) {
              return { translateToString: (_trimRight?: boolean) => "edit src/util.ts:7" } as unknown;
            }
            return undefined;
          },
        },
      },
    } as unknown as Terminal;
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage: vi.fn(),
      platform: "posix",
    });
    const links = collect(provider, 5);
    // Provider must START reading at row 0-based index 4 (NOT 5) — that's the
    // off-by-one this test guards. Wrap-aware logic also probes neighbors
    // (index 3 for the backward walk, index 5 for the forward walk) to detect
    // continuations; that's expected and unrelated to the original bug.
    expect(seen[0]).toBe(4);
    expect(links).toHaveLength(1);
    expect(links![0].range.start.y).toBe(5);
    expect(links![0].range.end.y).toBe(5);
  });

  it("returns one ILink for `src/foo.ts:42`", () => {
    const terminal = makeTerminalStub("at src/foo.ts:42 fail");
    const postMessage = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    const links = collect(provider);
    expect(Array.isArray(links)).toBe(true);
    expect(links).toHaveLength(1);
    const link = links![0];
    expect(link.text).toBe("src/foo.ts:42");
    expect(link.decorations!.underline).toBe(true);
    expect(link.decorations!.pointerCursor).toBe(true);
    // index of "src/foo.ts:42" in "at src/foo.ts:42 fail" = 3; 1-based start = 4; end inclusive = 4 + 13 - 1 = 16.
    // y === bufferLineNumber (1-based) — collect() called provideLinks(1, ...).
    expect(link.range.start).toEqual({ x: 4, y: 1 });
    expect(link.range.end).toEqual({ x: 16, y: 1 });
  });

  it("activate posts openFile message with parsed path, line, and sessionId", () => {
    const terminal = makeTerminalStub("at src/foo.ts:42 fail");
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-XYZ",
      postMessage,
      platform: "posix",
    });
    const links = collect(provider);
    expect(links).toHaveLength(1);
    links![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, links![0].text);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path: "src/foo.ts",
      sessionId: "sess-XYZ",
      line: 42,
    });
  });

  it("omits col when not parsed", () => {
    const terminal = makeTerminalStub("at src/foo.ts:42 fail");
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    const links = collect(provider);
    links![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, "");
    const sentMsg = postMessage.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect("col" in sentMsg).toBe(false);
  });

  it("includes col when parsed", () => {
    const terminal = makeTerminalStub("at src/foo.ts:42:7 fail");
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    const links = collect(provider);
    links![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, "");
    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path: "src/foo.ts",
      sessionId: "sess-1",
      line: 42,
      col: 7,
    });
  });

  it("respects the parser's 10-result cap", () => {
    const parts = Array.from({ length: 15 }, (_, i) => `src/foo${i}.ts`).join(" ");
    const terminal = makeTerminalStub(parts);
    const postMessage = vi.fn();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "posix",
    });
    const links = collect(provider);
    expect(links).toHaveLength(10);
  });

  it("soft-wrap: hovering the continuation row of a wrapped path returns the FULL path", () => {
    // Real-world repro: long path wrapped across two terminal rows. The user
    // hovered the second visible row (rPreviewPopup.ts portion) and the link
    // matched only that fragment — host returned `not-found`. Wrap-aware
    // resolution concatenates the rows, runs the parser on the full string,
    // then emits a per-row segment with the FULL matched path on link.text.
    const rowTexts = [
      "Update(/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/Hove",
      "rPreviewPopup.ts)",
    ];
    const terminal = makeWrappedTerminalStub(rowTexts);
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-W",
      postMessage,
      platform: "posix",
    });
    // Hover the SECOND visible row (1-based row 2).
    const linksRow2 = collect(provider, 2);
    expect(linksRow2).toHaveLength(1);
    // link.text carries the FULL matched path — the host uses this to open / preview.
    expect(linksRow2![0].text).toBe(
      "/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/HoverPreviewPopup.ts",
    );
    // The range covers only the segment on THIS row (col 1..end of "rPreviewPopup.ts").
    expect(linksRow2![0].range.start).toEqual({ x: 1, y: 2 });
    expect(linksRow2![0].range.end.x).toBe("rPreviewPopup.ts".length);
    expect(linksRow2![0].range.end.y).toBe(2);

    // Activate must post the full path, not the fragment.
    linksRow2![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, linksRow2![0].text);
    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path: "/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/HoverPreviewPopup.ts",
      sessionId: "sess-W",
    });
  });

  it("application-emitted line break + indent (NOT xterm soft-wrap) is treated as continuation via heuristic", () => {
    // Reproduces the claude-code / agent style output where the application
    // prints its own newline and indents the continuation. xterm sees TWO
    // separate logical lines (`isWrapped` stays false on both), but visually
    // it looks like a wrapped path. Heuristic: row 1 ends with non-whitespace
    // path char AND fills the row width AND row 2 starts with whitespace+
    // path chars → treat as continuation, strip the indent before joining.
    const cols = 80;
    // Row 1: padded to full row width to indicate "no trailing space" → wrap.
    const part1 = "Update(/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/Hove";
    const _row1Padded = part1.padEnd(cols, " ").slice(0, cols);
    // Heuristic requires row1 to have NO trailing whitespace. So row 1 must be
    // exactly cols chars of content. Adjust:
    const fullPath = "/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/HoverPreviewPopup.ts";
    const row1 = `Update(${fullPath.slice(0, cols - 7)}`; // 7 = len("Update(")
    const row2Content = `${fullPath.slice(cols - 7)})`;
    const row2 = `    ${row2Content}`; // indented (application style)
    const rowTexts = [row1, row2];

    // Each rowTexts[k] is treated as the line's translateToString output. The
    // heuristic kicks in only when row1's length === row1.trimEnd().length
    // (i.e. no trailing spaces). row1 above ends in a path char, so passes.
    // Application-emitted: BOTH rows have isWrapped=false — provider must
    // detect the continuation via the indent/full-width heuristic.
    const terminal = makeWrappedTerminalStub(rowTexts, [false, false]);
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-H",
      postMessage: vi.fn(),
      platform: "posix",
    });
    const linksRow2 = collect(provider, 2);
    expect(linksRow2).toHaveLength(1);
    expect(linksRow2![0].text).toBe(fullPath);
    // The segment range on row 2 must skip the 4-char indent.
    expect(linksRow2![0].range.start).toEqual({ x: 4 + 1, y: 2 });
  });

  it("soft-wrap: hovering the START row of a wrapped path also returns a segment of the full match", () => {
    const rowTexts = [
      "Update(/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/Hove",
      "rPreviewPopup.ts)",
    ];
    const terminal = makeWrappedTerminalStub(rowTexts);
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-W",
      postMessage: vi.fn(),
      platform: "posix",
    });
    const linksRow1 = collect(provider, 1);
    expect(linksRow1).toHaveLength(1);
    expect(linksRow1![0].text).toBe(
      "/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/HoverPreviewPopup.ts",
    );
    expect(linksRow1![0].range.start.y).toBe(1);
    expect(linksRow1![0].range.end.y).toBe(1);
    // Range must end at the last column of row 1 (it's wrapped — the match continues into row 2).
    expect(linksRow1![0].range.end.x).toBe(rowTexts[0].length);
  });

  it("does NOT join unrelated full-width rows that lack a tool-call / absolute-path signal (round-2 W6)", () => {
    // Round-2 W6: the structural in-path wrap rule used to fire for any two
    // adjacent rows where row 1 exactly filled cols AND both ends were path
    // chars. Common false case: `user@host:/some/long/dir$` filling 80 cols
    // + `-rw-r--r--` on the next row. After W6 the heuristic requires row 1
    // to look like a tool-call (`Read(`, `Edit(`, etc.) OR contain an
    // absolute path token. The shell-prompt + ls case has neither.
    const row1 = "user@host:/some/very/long/working/directory/here-now$"; // not a tool-call, no absolute path with /
    // Pad row1 to exactly 80 chars with NO trailing whitespace so the
    // prevRaw.length === prevTrim.length check passes (this would have
    // previously triggered the structural join).
    const padded = row1.padEnd(80, "x").slice(0, 80);
    const row2 = "-rw-r--r--  1 user group 4096 May 21 10:00 README.md";
    const terminal = makeWrappedTerminalStub([padded, row2], [false, false]);
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-W6",
      postMessage: vi.fn(),
      platform: "posix",
    });
    // Hover row 2 — the heuristic must NOT join with row 1. The parser then
    // sees only row 2's content and matches `README.md` as a bare path.
    const linksRow2 = collect(provider, 2);
    expect(linksRow2).toHaveLength(1);
    // The match must be the BARE basename from row 2, NOT a Frankenstein
    // concatenation of `here-now$...-rw-r--r--...README.md`.
    expect(linksRow2![0].text).toBe("README.md");
  });

  it("Claude CLI wrap at the `·` separator joins rows so the path + line are detected", () => {
    // Claude CLI tool-call narration wraps inside `Read(<path> · lines N-M)`.
    // The break commonly lands at the space between `<path>` and `·`. Both
    // rows have isWrapped=false (application-emitted newline), so the
    // heuristic must recognise `· line(s)` as a continuation marker.
    const path = "/Users/huybuidac/anywhere-terminal/src/webview/links/HoverPreviewPopup.test.ts";
    const row1 = `Read(${path} `; // application emits trailing space then newline
    const row2 = "· lines 180-299)";
    const terminal = makeWrappedTerminalStub([row1, row2], [false, false]);
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-C",
      postMessage,
      platform: "posix",
    });
    // Hover the wrapped row (row 2). The provider must walk back, join with
    // row 1, and emit a link whose payload carries the FULL path + line 180.
    const linksRow2 = collect(provider, 2);
    expect(linksRow2).toHaveLength(1);
    linksRow2![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, linksRow2![0].text);
    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path,
      sessionId: "sess-C",
      line: 180,
    });
  });

  it("Claude CLI wrap between `lines` keyword and the number", () => {
    // Less common but possible: wrap after `lines ` so the number is alone on
    // row 2. Row 1 ends with the word `lines`, row 2 starts with a digit.
    const path = "/abs/foo.ts";
    const row1 = `Read(${path} · lines `;
    const row2 = "42)";
    const terminal = makeWrappedTerminalStub([row1, row2], [false, false]);
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-C2",
      postMessage,
      platform: "posix",
    });
    const linksRow2 = collect(provider, 2);
    expect(linksRow2).toHaveLength(1);
    linksRow2![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, linksRow2![0].text);
    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path,
      sessionId: "sess-C2",
      line: 42,
    });
  });

  it("passes through to win32 path detection when platform is win32", () => {
    const terminal = makeTerminalStub(String.raw`hit C:\Users\foo\bar.ts:42 done`);
    const postMessage = vi.fn<(msg: WebViewToExtensionMessage) => void>();
    const provider = new FilePathLinkProvider({
      terminal,
      sessionId: "sess-1",
      postMessage,
      platform: "win32",
    });
    const links = collect(provider);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe(String.raw`C:\Users\foo\bar.ts:42`);
    links![0].activate({ preventDefault: () => {} } as unknown as MouseEvent, links![0].text);
    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path: String.raw`C:\Users\foo\bar.ts`,
      sessionId: "sess-1",
      line: 42,
    });
  });
});
