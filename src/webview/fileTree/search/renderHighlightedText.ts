// src/webview/fileTree/search/renderHighlightedText.ts — Inline DOM helper.
//
// Builds a sequence of alternating Text nodes and `<span class="...match...">`
// spans for `text`, wrapping each `match` range in a highlight span. We
// vendor the scorer (`fuzzyScore`) but NOT VSCode's `HighlightedLabel` —
// the class drags in IconLabel, hover, lifecycle, etc. for capabilities
// we don't need in v1. See: design.md D10.
//
// The function clears `container` before rendering, so it's safe to call on
// a recycled DOM node without the caller worrying about prior content. Out-
// of-range / overlapping / unsorted ranges are clamped: starts beyond
// `text.length` are skipped, ends are clamped to `text.length`, ranges that
// decrease (start <= prevEnd) are merged onto the prior span.

import type { ITreeMatchData } from "../ITreeRenderer";

/** CSS class applied to every highlighted character span. */
export const FILE_TREE_SEARCH_MATCH_CLASS = "file-tree-search-match";

export function renderHighlightedText(
  container: HTMLElement,
  text: string,
  matches: ITreeMatchData["matches"] | undefined,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (!matches || matches.length === 0) {
    container.appendChild(doc.createTextNode(text));
    return;
  }
  let cursor = 0;
  for (const m of matches) {
    const start = Math.max(m.start, cursor);
    const end = Math.min(m.end, text.length);
    if (end <= start) {
      continue;
    }
    if (start > cursor) {
      container.appendChild(doc.createTextNode(text.slice(cursor, start)));
    }
    const span = doc.createElement("span");
    span.className = FILE_TREE_SEARCH_MATCH_CLASS;
    span.textContent = text.slice(start, end);
    container.appendChild(span);
    cursor = end;
  }
  if (cursor < text.length) {
    container.appendChild(doc.createTextNode(text.slice(cursor)));
  }
}
