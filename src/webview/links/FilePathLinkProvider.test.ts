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
                translateToString: (_trimRight?: boolean) => line,
              }
            : undefined,
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
    expect(seen).toEqual([4]); // not 5 — provider subtracted 1
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
