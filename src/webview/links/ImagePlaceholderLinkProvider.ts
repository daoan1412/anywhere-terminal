// src/webview/links/ImagePlaceholderLinkProvider.ts — A third xterm link
// provider (alongside FilePathLinkProvider + SubagentLinkProvider) that makes a
// pasted-image placeholder (`[Image #N]` / `[Image N]`) hoverable. Hovering it
// previews the image captured at paste time from this terminal's PastedImageStore.
//
// Single-row matcher (no soft-wrap back-walk) mirroring SubagentLinkProvider —
// placeholders are short and live on the input line.
//
// See: asimov/changes/preview-pasted-images/design.md D4, D5;
//   specs/pasted-image-preview/spec.md "Image Placeholder Detection".

import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import type { HoverPreviewController } from "./HoverPreviewController";
import { parseImagePlaceholders } from "./imagePlaceholderParser";
import type { PastedImageStore } from "./PastedImageStore";

export interface ImagePlaceholderLinkProviderDeps {
  terminal: Terminal;
  /** This terminal's pasted-image cache; resolves the hovered placeholder number. */
  store: PastedImageStore;
  /** Reused hover machinery — installs the debounce + popup on each link. */
  hoverController: HoverPreviewController;
}

export class ImagePlaceholderLinkProvider implements ILinkProvider {
  private readonly terminal: Terminal;
  private readonly store: PastedImageStore;
  private readonly hoverController: HoverPreviewController;
  private disposed = false;

  constructor(deps: ImagePlaceholderLinkProviderDeps) {
    this.terminal = deps.terminal;
    this.store = deps.store;
    this.hoverController = deps.hoverController;
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
    const matches = parseImagePlaceholders(line.translateToString(true));
    if (matches.length === 0) {
      callback(undefined);
      return;
    }
    // The placeholders on this row are the current prompt's image batch. The
    // CLI renumbers per prompt (and Claude shares the counter with text), so a
    // placeholder's absolute number is not its store position. Map by RELATIVE
    // rank (ascending number) onto the most-recently pasted images instead, so
    // the newest placeholder resolves to the newest image. See design D3.
    const orderedNums = matches.map((m) => m.num).sort((a, b) => a - b);
    const batchSize = orderedNums.length;
    // xterm buffer ranges are 1-based with an INCLUSIVE end column.
    const links = matches.map((match) => {
      const rank = orderedNums.indexOf(match.num);
      const link: ILink = {
        text: match.raw,
        range: {
          start: { x: match.startCol + 1, y: bufferLineNumber },
          end: { x: match.endCol + 1, y: bufferLineNumber },
        },
        decorations: { underline: true, pointerCursor: true },
        // Preview is hover-only; a click is a no-op (swallow it).
        activate: (event: MouseEvent) => event.preventDefault(),
      };
      this.hoverController.attachImageHover(link, () => this.store.resolveRecent(rank, batchSize));
      return link;
    });
    callback(links);
  }

  /** Idempotent — the provider holds no DOM/listener resources of its own. */
  dispose(): void {
    this.disposed = true;
  }
}
