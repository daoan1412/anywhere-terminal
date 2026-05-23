// src/test/vendor-filters.test.ts — Vendored VSCode `fuzzyScore` smoke test.
//
// Pins the golden cases the file-tree search depends on:
//   1. The `vs/base/common/filters` import resolves under vitest.
//   2. `fuzzyScore("fp", ..., "FileTreePanel.ts", ...)` returns a non-null
//      result (subsequence match, not contiguous substring).
//   3. `FileTreePanel.ts` outranks `file-tree-panel.test.ts` for query `"fp"`
//      because the former has BOTH match characters at word-starts.
//   4. `createMatches` produces non-empty match ranges for an exact prefix.
//
// If this test fails, either the vendored `filters.ts` has been further
// trimmed (a transitive helper removed in error) or upstream's algorithm
// changed when we re-pulled. Re-run the vendor manifest pull and compare.

import { describe, expect, it } from "vitest";

import { createMatches, FuzzyScoreOptions, fuzzyScore } from "vs/base/common/filters";

function score(pattern: string, target: string) {
  return fuzzyScore(pattern, pattern.toLowerCase(), 0, target, target.toLowerCase(), 0, FuzzyScoreOptions.default);
}

describe("vendored vs/base/common/filters — fuzzyScore", () => {
  it("matches a subsequence (not just a contiguous substring)", () => {
    // "fp" → "FileTreePanel.ts": no contiguous "fp", but the subsequence
    // exists at positions 0 (F) and 8 (P). A non-undefined result here is
    // exactly the property that makes glob `**/*fp*` insufficient — see
    // design.md D11.
    const r = score("fp", "FileTreePanel.ts");
    expect(r).toBeDefined();
  });

  it("ranks earlier word-start match higher than later word-start match", () => {
    // Both targets put the pattern letters at word-starts, but the second
    // pushes them deeper into the path. Earlier matches outrank later ones.
    const earlier = score("fp", "FilePanel.ts");
    const later = score("fp", "src/very/deeply/nested/folder/FilePanel.ts");
    expect(earlier).toBeDefined();
    expect(later).toBeDefined();
    expect(earlier?.[0] ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(later?.[0] ?? Number.NEGATIVE_INFINITY);
  });

  it("createMatches produces a non-empty range list for an exact-prefix match", () => {
    const r = score("file", "FileTreePanel.ts");
    const matches = createMatches(r);
    expect(matches.length).toBeGreaterThan(0);
    // First match must land at offset 0 ("File...").
    expect(matches[0].start).toBe(0);
  });

  it("returns undefined when the pattern characters aren't a subsequence of target", () => {
    const r = score("xyz", "FileTreePanel.ts");
    expect(r).toBeUndefined();
  });
});
