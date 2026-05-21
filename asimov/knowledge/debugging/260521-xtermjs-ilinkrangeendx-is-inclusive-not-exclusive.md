---
labels: [xtermjs, link-provider, off-by-one]
source: add-clickable-file-paths
summary: The end.x field in xterm.js IBufferRange is 1-based and INCLUSIVE of the last character — off-by-one bug risk.
---
# xterm.js ILink.range.end.x is INCLUSIVE not exclusive
**Date**: 2026-05-21

## TL;DR
- xterm.js `ILink.range` uses 1-based coordinates.
- **`end.x` is INCLUSIVE** of the last character.
- For text of length L starting at 0-based offset `index`, range is `start.x = index + 1`, `end.x = index + L` (NOT `index + L + 1`).
- Forgetting this causes: underlines shifted by 1, characters cut off, or text beyond link highlighted.

## Context
xterm.js buffer positions differ from typical string slicing:
- String API: slice(0, 3) includes indices 0, 1, 2 (3 chars, end is exclusive).
- xterm.js ILink: start.x=1, end.x=3 means columns 1, 2, 3 (3 chars, end is INCLUSIVE).

## Evidence
### Anchors
- `src/webview/links/FilePathLinkProvider.ts` lines 58–62 → correct range calculation:
  - grep: `start: { x: p.index + 1, y: bufferLineNumber }`
  - grep: `end: { x: p.index + p.text.length, y: bufferLineNumber }`
  - Comment on line 58: `// xterm.js buffer ranges are 1-based; end.x is INCLUSIVE of the last char`

### Excerpt
```ts
const range = {
  start: { x: p.index + 1, y: bufferLineNumber },
  end: { x: p.index + p.text.length, y: bufferLineNumber },  // NOT +1
};
```

## Prevention Gate
When implementing xterm.js link providers or buffer operations:
1. Remember: xterm buffer positions are 1-based (unlike 0-based strings).
2. For range `{ start, end }`, end is INCLUSIVE — it marks the last character in the range.
3. If matching a string at 0-based `index` of length L:
   - start.x = index + 1
   - end.x = index + L (not index + L + 1)
4. Double-check by verifying underline covers the exact matched text in a terminal.

## When to apply
- Implementing custom link providers in xterm.js.
- Writing tests that stub `ILink` ranges.
- Migrating code from other terminal emulators (which may use different coordinate systems).
