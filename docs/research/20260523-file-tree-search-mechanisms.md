---
topic: file-tree-search-mechanisms
created-by: research for file-tree search/filter design in a VS Code webview using vendored listWidget
date: 2026-05-23
libraries: [vscode, fuzzysort, fuse.js, fzy.js, fzf]
used-by: []
---

# Research: file-tree-search-mechanisms

## Answers

- **VS Code tree find widget**: the relevant classes are in `src/vs/base/browser/ui/tree/abstractTree.ts`.
  - `FindFilter` is ~100 LOC (`626-725`), `FindWidget` is ~148 LOC (`823-970`), `FindController` is ~140 LOC (`1120-1259`).
  - It renders a small overlay with a `FindInput`, an `ActionBar`, and two toggles: **Filter** vs **Highlight**, and **Fuzzy Match** vs **Contiguous**. It does **not** provide editor-style “match case / whole word” toggles; `showCommonFindToggles` is disabled.
  - It does **not** score-and-sort tree rows. `FindFilter.filter()` returns a `FuzzyScore` plus a `TreeVisibility` state; the tree model then refilters/hides nodes or leaves them visible. `FindController.applyPattern()` calls `tree.refilter()`, focuses the next match, and reveals it.

- **Fuzzy matching algorithm**:
  - Tree find uses `vs/base/common/filters.ts` `fuzzyScore()` (the core path is around `652-885`). This is a **dynamic-programming subsequence aligner**, not Bitap.
  - Behavior: query chars must appear in order; scoring prefers word starts, path separators, camelCase transitions, consecutive characters, exact case, and shorter/earlier alignments. It backtracks through a matrix to recover matched positions.
  - `vs/base/common/fuzzyScorer.ts` wraps the same core scorer for label/description/path items and adds stronger prefix/path weighting and caching.

- **Highlight rendering**:
  - Tree rows receive `matches: createMatches(filterData)` in renderers such as `workbench/contrib/files/browser/views/explorerViewer.ts` (`993-1020`).
  - `IconLabel` hands those match ranges to `HighlightedLabel`, which wraps matched substrings in `<span class="highlight">…</span>`.
  - Explorer also adds a `CountBadge` to highlighted folders for “contains N matches”.

- **Transitive closure size if we tried to vendor the VS Code find widget + scorer**:
  - Core tree-find implementation: ~388 LOC (`FindFilter` + `FindWidget` + `FindController` only).
  - Practical closure with direct UI dependencies is much larger: `findInput.ts` (421 LOC), `inputBox.ts` (841), `actionbar.ts` (678), `toggle.ts` (523), `highlightedLabel.ts` (164), `filters.ts` (950). That is roughly **4.0k LOC** before any tree-model glue.
  - For a webview that already has list rendering, the UI chrome is the expensive part; the scorer itself is comparatively small.

## Recommended Approach

- **Do not port the full VS Code widget** unless you need its exact UX and history/toggle chrome.
- **Best fit**: use a lightweight fuzzy library plus custom UI/filter plumbing. For file trees, `fzy.js` is the smallest good-ranked option; `fuzzysort` is a strong general-purpose alternative.
- If you want the closest VS Code-like behavior, vendor **just the scorer/match-highlighting logic**, not the whole `abstractTree` widget stack.

## Comparison Table

| Option | Algorithm | Size signal | Pros | Cons | Fit for 10k-file webview |
|---|---|---:|---|---|---|
| VS Code tree find widget | DP subsequence scoring (`fuzzyScore`) + tree refilter | ~4.0k LOC closure if ported with direct deps | Closest UX to VS Code; highlights already integrated | Heavy dependency surface; needs tree/label plumbing | Good, but overkill |
| `fuzzysort` | SublimeText-like fuzzy ranking | `npm pack`: 14.1 kB tarball, 45.6 kB unpacked | Fast, prepared targets, good JS API | Not as small as `fzy.js` | Very good |
| `fuse.js` | Bitap approximate matching | Bundlephobia: 23.7 kB minified / 8.3 kB gzip; npm unpacked 311.6 kB | Mature, flexible multi-key search | Heavier and more “search engine” than file-finder | Good, but heavier than needed |
| `fzy.js` | fzy scoring (word-start / separator biased ranking) | `npm pack`: 3.8 kB tarball, 13.3 kB unpacked | Tiny, file-finder style ranking, easy to embed | Narrower API, fewer extras | Excellent |
| `fzf` / fzf-for-js | Modified Smith-Waterman style fuzzy finder | `npm pack`: 21.1 kB tarball, 70.6 kB unpacked | Strong ranking model, closer to terminal fzf | Larger, more featureful than needed | Good |
| Hand-rolled subsequence scorer | Custom | ~100 LOC | Smallest, fully tailored | You own ranking quality and edge cases | Good if requirements are simple |

## Performance Considerations

- For incremental search on **10k visible items**, target a **single-frame budget (~16 ms)** per keystroke; if scoring exceeds that, debounce or chunk work.
- VS Code does **not** appear to maintain a client-side pre-index for tree find; generic tree find rescans/refilters, and explorer search delegates to the workspace search service with `cacheKey`-based caching.
- For this use case, pre-normalizing labels and reusing the previous result set for the next keystroke matters more than sophisticated indexing.

## VS Code Explorer Pattern

- The Explorer does **not** use workspace-wide Quick Open for tree find.
- It wires an `ExplorerFindProvider` into the async tree find surface. In **Filter** mode it calls `searchService.fileSearch()` with glob patterns (`**/${pattern}` and `**/${pattern}/**`), then marks matching items and phantom parents.
- In **Highlight** mode it keeps the tree visible and rerenders matching nodes/badges.

## Gaps

- GitHub’s internal file-finder algorithm is not publicly documented; public analogs are the best available comparison.
- Exact Bundlephobia gzip numbers were not available for every package in this session; for `fuzzysort`, `fzy.js`, and `fzf` the most reliable numbers obtained were `npm pack` tarball/unpacked sizes.

## Sources

- VS Code tree find implementation: `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/base/browser/ui/tree/abstractTree.ts`
- VS Code fuzzy scorer: `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/base/common/filters.ts`
- VS Code label highlighting: `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/base/browser/ui/highlightedlabel/highlightedLabel.ts`
- Explorer tree search/highlight wiring: `/Users/huybuidac/Projects/ai-oss/vscode/src/vs/workbench/contrib/files/browser/views/explorerViewer.ts`
- `fuzzysort`: [npm](https://www.npmjs.com/package/fuzzysort), [GitHub](https://github.com/farzher/fuzzysort), [Bundlephobia](https://bundlephobia.com/package/fuzzysort)
- `fuse.js`: [npm](https://www.npmjs.com/package/fuse.js), [GitHub](https://github.com/krisk/Fuse), [Docs](https://www.fusejs.io/), [Bundlephobia](https://bundlephobia.com/package/fuse.js)
- `fzy.js`: [npm](https://www.npmjs.com/package/fzy.js), [GitHub](https://github.com/jhawthorn/fzy.js/)
- `fzf`: [npm](https://www.npmjs.com/package/fzf), [GitHub](https://github.com/ajitid/fzf-for-js)
- Fuzzy algorithm references: [fzy ALGORITHM.md](https://github.com/jhawthorn/fzy/blob/master/ALGORITHM.md), [fzf algo.go](https://github.com/junegunn/fzf/blob/master/src/algo/algo.go), [GitHub file finder discussion](https://github.com/jamis/fuzzy_file_finder), [Sublime fuzzy search summary](https://github.com/farzher/fuzzysort)
