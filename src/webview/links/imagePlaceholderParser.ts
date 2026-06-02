// src/webview/links/imagePlaceholderParser.ts — Detect the placeholders that
// Claude CLI / Codex (`[Image #N]`) and OpenCode (`[Image N]`) render for a
// pasted image. Pure (no xterm/DOM) so it is unit-testable.
//
// See: asimov/changes/preview-pasted-images/design.md D5

export interface ImagePlaceholderMatch {
  /** Placeholder number N from `[Image #N]` / `[Image N]`. */
  num: number;
  /** 0-based column of the opening `[`. */
  startCol: number;
  /** 0-based column of the closing `]` (inclusive). */
  endCol: number;
  /** The literal matched text, e.g. `[Image #3]` or `[Image 3]`. */
  raw: string;
}

/**
 * Find every `[Image #N]` / `[Image N]` placeholder on a single row of terminal
 * text. Columns are character offsets into `line` (one cell per char — a wide
 * CJK glyph before a placeholder would offset it, an accepted limitation
 * matching SubagentLinkProvider's single-row mapping).
 */
export function parseImagePlaceholders(line: string): ImagePlaceholderMatch[] {
  const re = /\[Image #?(\d+)\]/g;
  const out: ImagePlaceholderMatch[] = [];
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    const num = Number.parseInt(m[1], 10);
    if (Number.isFinite(num)) {
      out.push({ num, startCol: m.index, endCol: m.index + m[0].length - 1, raw: m[0] });
    }
    m = re.exec(line);
  }
  return out;
}
