// src/providers/pathResolution.test.ts — Focused unit tests for the shared
// candidate-building helper extracted from `openFileLink.ts`.
//
// `openFileLink.test.ts` exercises buildCandidates end-to-end via the click
// flow; these tests assert the helper's contract in isolation so future
// callers (e.g. `previewFileLink.ts`) have a sharp pin on its behavior.

import { describe, expect, it } from "vitest";
import { type BuildCandidatesDeps, buildCandidates, escapeGlob, hasTraversal, isAbsolutePath } from "./pathResolution";

function makeDeps(overrides: Partial<BuildCandidatesDeps> = {}): BuildCandidatesDeps {
  return {
    getInitialCwd: () => undefined,
    getCurrentCwd: () => undefined,
    workspaceFolders: undefined,
    ...overrides,
  };
}

describe("isAbsolutePath", () => {
  it("treats POSIX absolute paths as absolute", () => {
    expect(isAbsolutePath("/etc/hosts")).toBe(true);
    expect(isAbsolutePath("relative/path")).toBe(false);
    expect(isAbsolutePath("./foo")).toBe(false);
    expect(isAbsolutePath("../foo")).toBe(false);
  });
});

describe("hasTraversal", () => {
  it("flags any segment equal to ..", () => {
    expect(hasTraversal("../foo")).toBe(true);
    expect(hasTraversal("a/../b")).toBe(true);
    expect(hasTraversal("a\\..\\b")).toBe(true);
  });
  it("does not flag .. inside a longer segment", () => {
    expect(hasTraversal("foo..bar")).toBe(false);
    expect(hasTraversal("..bar")).toBe(false);
  });
});

describe("escapeGlob", () => {
  it("wraps glob meta-chars in char classes so they match literally", () => {
    expect(escapeGlob("a*b")).toBe("a[*]b");
    expect(escapeGlob("a?b")).toBe("a[?]b");
    expect(escapeGlob("a[b]c")).toBe("a[[]b[]]c");
    expect(escapeGlob("a{b}c")).toBe("a[{]b[}]c");
  });
  it("leaves non-meta chars untouched", () => {
    expect(escapeGlob("foo/bar.ts")).toBe("foo/bar.ts");
  });
});

describe("buildCandidates", () => {
  it("returns a single absolute candidate when input is absolute (POSIX)", () => {
    const result = buildCandidates(
      { path: "/etc/hosts", sessionId: "s1" },
      makeDeps({ getInitialCwd: () => "/home/me" }),
      "/cwd/of/pty",
    );
    expect(result.candidates).toEqual(["/etc/hosts"]);
    expect(result.sourceCounts).toEqual({ absolute: 1 });
    expect(result.malformed).toBe(false);
  });

  it("returns empty + malformed for a broken file:// URI", () => {
    const result = buildCandidates({ path: "file://garbage", sessionId: "s1" }, makeDeps(), undefined);
    // expandTildeAndFileUri returns kind=passthrough-malformed for this shape;
    // the helper must propagate that signal so callers can skip findFiles.
    expect(result.malformed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it("fans out across liveCwd, currentCwd, initialCwd, workspace folders in that order", () => {
    const result = buildCandidates(
      { path: "file.md", sessionId: "s1" },
      makeDeps({
        getInitialCwd: () => "/init",
        getCurrentCwd: () => "/current",
        workspaceFolders: [{ uri: { fsPath: "/ws-a" } }, { uri: { fsPath: "/ws-b" } }],
      }),
      "/live",
    );
    expect(result.candidates).toEqual([
      "/live/file.md",
      "/current/file.md",
      "/init/file.md",
      "/ws-a/file.md",
      "/ws-b/file.md",
    ]);
    expect(result.sourceCounts).toMatchObject({
      liveCwd: 1,
      currentCwd: 1,
      initialCwd: 1,
      "ws[0]": 1,
      "ws[1]": 1,
    });
  });

  it("deduplicates identical absolute paths across sources", () => {
    const result = buildCandidates(
      { path: "file.md", sessionId: "s1" },
      makeDeps({
        getInitialCwd: () => "/same",
        getCurrentCwd: () => "/same",
        workspaceFolders: [{ uri: { fsPath: "/same" } }],
      }),
      "/same",
    );
    // Four sources all point at /same/file.md — should appear ONCE.
    expect(result.candidates).toEqual(["/same/file.md"]);
    expect(Object.keys(result.sourceCounts)).toContain("liveCwd");
    expect(result.sourceCounts.currentCwd).toBeUndefined();
    expect(result.sourceCounts.initialCwd).toBeUndefined();
  });

  it("applies the cwd-suffix duplication trick: cwd ends with link prefix → two candidates", () => {
    const result = buildCandidates(
      { path: "a/file.md", sessionId: "s1" },
      makeDeps({ getInitialCwd: () => "/x/y/a" }),
      undefined,
    );
    expect(result.candidates).toEqual(["/x/y/a/a/file.md", "/x/y/a/file.md"]);
  });

  it("skips sources whose cwd is undefined without crashing", () => {
    const result = buildCandidates(
      { path: "file.md", sessionId: "s1" },
      makeDeps({
        // All sources undefined → no candidates, no source counts, malformed false.
        workspaceFolders: [],
      }),
      undefined,
    );
    expect(result.candidates).toEqual([]);
    expect(result.sourceCounts).toEqual({});
    expect(result.malformed).toBe(false);
  });

  it("expands a leading tilde via expandTildeAndFileUri before fan-out", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const result = buildCandidates({ path: "~/file.md", sessionId: "s1" }, makeDeps(), undefined);
    // After tilde expansion the path becomes absolute → single candidate.
    if (home) {
      expect(result.candidates).toEqual([`${home}/file.md`]);
      expect(result.sourceCounts).toEqual({ absolute: 1 });
    }
  });
});
