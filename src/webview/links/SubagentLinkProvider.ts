// src/webview/links/SubagentLinkProvider.ts — A second xterm link provider
// (alongside FilePathLinkProvider) that makes a Claude CLI subagent (Task)
// invocation header line clickable. A click opens a floating popup previewing the
// subagent's sub-session transcript.
//
// Unlike FilePathLinkProvider this needs NO wrap/back-walk: the header is matched
// on its OWN single row (design.md D1/D2) and emitted as one single-row ILink.
//
// See: specs/terminal-subagent-preview/spec.md; design.md D1, D2, D3.

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { parseSubagentHeader } from "./subagentLineParser";

export interface SubagentLinkProviderDeps {
  terminal: Terminal;
  /**
   * Invoked when a subagent header link is clicked. Receives the parsed agent
   * type (for the popup header badge), the verbatim description, and the click
   * viewport coordinates so the factory can anchor the popup and post
   * `requestSubagentPreview`.
   */
  onActivate: (agentType: string, description: string, x: number, y: number) => void;
}

export class SubagentLinkProvider implements ILinkProvider {
  private readonly terminal: Terminal;
  private readonly onActivate: (agentType: string, description: string, x: number, y: number) => void;
  private disposed = false;

  constructor(deps: SubagentLinkProviderDeps) {
    this.terminal = deps.terminal;
    this.onActivate = deps.onActivate;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    if (this.disposed) {
      callback(undefined);
      return;
    }
    // xterm passes a 1-based row number; IBuffer.getLine is 0-based.
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) {
      callback(undefined);
      return;
    }
    const header = parseSubagentHeader(line.translateToString(true));
    if (!header) {
      callback(undefined);
      return;
    }
    // xterm buffer ranges are 1-based with an INCLUSIVE end column (design.md D11).
    const link: ILink = {
      text: header.description,
      range: {
        start: { x: header.startCol + 1, y: bufferLineNumber },
        end: { x: header.endCol + 1, y: bufferLineNumber },
      },
      decorations: { underline: true, pointerCursor: true },
      activate: (event: MouseEvent) => {
        event.preventDefault();
        this.onActivate(header.name, header.description, event.clientX, event.clientY);
      },
    };
    callback([link]);
  }

  /** Idempotent — the provider holds no DOM/listener resources of its own. */
  dispose(): void {
    this.disposed = true;
  }
}
