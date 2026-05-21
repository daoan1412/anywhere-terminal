// src/webview/links/FilePathLinkProvider.ts — xterm.js link provider for file paths.
//
// Detects file paths in terminal buffer lines (via filePathParser) and exposes
// them to xterm.js as clickable, underlined links. Activation sends an
// `openFile` message to the extension host for resolution + opening.
//
// See: asimov/specs/terminal-clickable-file-paths/spec.md
// See: asimov/changes/add-clickable-file-paths/design.md D1, D2, D5, D10, D11

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { OpenFileMessage, WebViewToExtensionMessage } from "../../types/messages";
import { detectFilePathLinks } from "./filePathParser";

/** Dependencies for FilePathLinkProvider. */
export interface FilePathLinkProviderDeps {
  terminal: Terminal;
  sessionId: string;
  postMessage: (msg: WebViewToExtensionMessage) => void;
  platform: "posix" | "win32";
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

  constructor(deps: FilePathLinkProviderDeps) {
    this.terminal = deps.terminal;
    this.sessionId = deps.sessionId;
    this.postMessage = deps.postMessage;
    this.platform = deps.platform;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(bufferLineNumber);
    if (!line) {
      callback(undefined);
      return;
    }
    const text = line.translateToString(false);
    if (text.length === 0) {
      callback(undefined);
      return;
    }
    const parsed = detectFilePathLinks(text, this.platform);
    if (parsed.length === 0) {
      callback(undefined);
      return;
    }

    const links: ILink[] = parsed.map((p) => {
      // xterm.js buffer ranges are 1-based; end.x is INCLUSIVE of the last char (design.md D11).
      const range = {
        start: { x: p.index + 1, y: bufferLineNumber },
        end: { x: p.index + p.text.length, y: bufferLineNumber },
      };
      return {
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
    });

    callback(links);
  }
}
