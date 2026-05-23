// src/webview/fileTree/search/__tests__/matching.test.ts — Unit tests for the
// fuzzy-score adapter. Pins the edge cases enumerated in file-tree-search
// spec "Search input edge cases" + the Filter / Highlight mode contracts.

import { describe, expect, it } from "vitest";
import type { FileTreeSearchResult } from "../../../../types/messages";
import { isEmptyQuery, scoreAndSort, scoreOne } from "../matching";

const PATHS = ["FileTreePanel.ts", "file-tree-panel.test.ts", "FileTreeRenderer.ts", "main.ts", "messageHandler.ts"];

function results(): FileTreeSearchResult[] {
  return PATHS.map((p) => ({ absolutePath: `/repo/${p}`, relativePath: p }));
}

describe("matching — scoreOne", () => {
  it("(a) `fp` matches `FileTreePanel.ts` (subsequence, not contiguous)", () => {
    const r = scoreOne("fp", { absolutePath: "/x", relativePath: "FileTreePanel.ts" });
    expect(r).not.toBeNull();
    expect(r?.matches.length).toBeGreaterThan(0);
  });

  it("(c) wildcard chars are treated as literals (no glob behavior)", () => {
    // If `*` were a glob, the query would match ANY target. Since it's
    // literal, a target with NO `*` in it must return null.
    expect(scoreOne("*", { absolutePath: "/x", relativePath: "foobar.ts" })).toBeNull();
    expect(scoreOne("?", { absolutePath: "/x", relativePath: "foobar.ts" })).toBeNull();
    expect(scoreOne("[", { absolutePath: "/x", relativePath: "foobar.ts" })).toBeNull();
  });

  it("(d) unicode multi-byte chars: query `日` matches `日本.md`", () => {
    const r = scoreOne("日", { absolutePath: "/x", relativePath: "日本.md" });
    expect(r).not.toBeNull();
  });

  it("(e) empty query returns null even when target is non-empty", () => {
    const r = scoreOne("", { absolutePath: "/x", relativePath: "anything.ts" });
    expect(r).toBeNull();
  });

  it("whitespace-only query treated as empty", () => {
    expect(scoreOne("   ", { absolutePath: "/x", relativePath: "foo.ts" })).toBeNull();
    expect(scoreOne("\t\n", { absolutePath: "/x", relativePath: "foo.ts" })).toBeNull();
  });

  it("backslash query is literal, no path normalization", () => {
    const r = scoreOne("\\", { absolutePath: "/x", relativePath: "foo\\bar.ts" });
    expect(r).not.toBeNull();
  });
});

describe("matching — isEmptyQuery", () => {
  it.each([
    ["", true],
    ["   ", true],
    ["\t", true],
    ["a", false],
    ["*", false],
    [" a ", false],
  ])("isEmptyQuery(%j) === %s", (q, expected) => {
    expect(isEmptyQuery(q)).toBe(expected);
  });
});

describe("matching — scoreAndSort, Filter mode", () => {
  it("empty query → empty array", () => {
    const out = scoreAndSort("", results(), "filter");
    expect(out).toEqual([]);
  });

  it("non-empty query → only matched rows, sorted by score then path length", () => {
    const out = scoreAndSort("fp", results(), "filter");
    expect(out.length).toBeGreaterThan(0);
    // All entries have matchData.
    expect(out.every((c) => c.matchData !== undefined)).toBe(true);
    // First result is one of the FileTree* paths (word-start match).
    const top = out[0]?.result.relativePath ?? "";
    expect(top.startsWith("FileTree")).toBe(true);
    // No unmatched paths in the result.
    const names = out.map((c) => c.result.relativePath);
    expect(names).not.toContain("main.ts");
  });
});

describe("matching — scoreAndSort, Highlight mode", () => {
  it("empty query → all candidates alphabetic, NO matchData", () => {
    const out = scoreAndSort("", results(), "highlight");
    expect(out).toHaveLength(PATHS.length);
    expect(out.every((c) => c.matchData === undefined)).toBe(true);
    // matching.ts uses `localeCompare` for the alphabetic sort — mirror it.
    expect(out.map((c) => c.result.relativePath)).toEqual([...PATHS].sort((a, b) => a.localeCompare(b)));
  });

  it("non-empty query → matched first, then unmatched alphabetic", () => {
    const out = scoreAndSort("fp", results(), "highlight");
    expect(out).toHaveLength(PATHS.length);
    // First N rows are matched (have matchData); remainder are unmatched
    // (no matchData) and sorted alphabetically.
    const firstUnmatchedIdx = out.findIndex((c) => c.matchData === undefined);
    expect(firstUnmatchedIdx).toBeGreaterThan(0);
    const matched = out.slice(0, firstUnmatchedIdx);
    const unmatched = out.slice(firstUnmatchedIdx);
    expect(matched.every((c) => c.matchData !== undefined)).toBe(true);
    expect(unmatched.every((c) => c.matchData === undefined)).toBe(true);
    const unmatchedNames = unmatched.map((c) => c.result.relativePath);
    expect(unmatchedNames).toEqual([...unmatchedNames].sort());
  });
});

describe("matching — tie-break", () => {
  it("(g) ties between identical scores prefer shorter relativePath, then alphabetic", () => {
    // Two paths that should produce equal scores (same word-start hits).
    const candidates: FileTreeSearchResult[] = [
      { absolutePath: "/x/a/b/c/FilePanel.ts", relativePath: "a/b/c/FilePanel.ts" },
      { absolutePath: "/x/FilePanel.ts", relativePath: "FilePanel.ts" },
    ];
    const out = scoreAndSort("fp", candidates, "filter");
    // Shorter wins the tie.
    expect(out[0]?.result.relativePath).toBe("FilePanel.ts");
  });
});
