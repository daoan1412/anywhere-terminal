// src/providers/ActiveFileRevealer.test.ts — Unit tests for ActiveFileRevealer
// + the exported matchesExclude helper.

import { Minimatch } from "minimatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __fireConfigChange,
  __getTabChangeListenerCount,
  __resetAll,
  __setActiveTab,
  __setWorkspaceFolders,
  TabInputCustom,
  TabInputNotebook,
  TabInputText,
  TabInputTextDiff,
} from "../test/__mocks__/vscode";
import type { RevealInFileTreeMessage } from "../types/messages";
import { ActiveFileRevealer, matchesExclude } from "./ActiveFileRevealer";

const NOCASE = process.platform !== "linux";

// ─── matchesExclude (pure helper, 4_1) ─────────────────────────────

describe("matchesExclude — ancestor walk", () => {
  function m(pattern: string): Minimatch {
    return new Minimatch(pattern, { dot: true, nocase: NOCASE });
  }

  it("matches when an ancestor folder matches **/node_modules", () => {
    expect(matchesExclude("node_modules/foo/bar.ts", [m("**/node_modules")])).toBe(true);
  });

  it("does not match when no ancestor matches", () => {
    expect(matchesExclude("src/foo.ts", [m("**/node_modules")])).toBe(false);
  });

  it("matches dotfiles when pattern uses **/.git (dot:true)", () => {
    expect(matchesExclude(".git/HEAD", [m("**/.git")])).toBe(true);
  });

  it("returns false for an empty path", () => {
    expect(matchesExclude("", [m("**/node_modules")])).toBe(false);
  });

  it("returns false when matcher list is empty", () => {
    expect(matchesExclude("node_modules/foo", [])).toBe(false);
  });

  it("treats backslashes as literal — caller is responsible for POSIX normalization", () => {
    // A path with backslashes should NOT match a POSIX pattern unless the
    // caller has already normalized separators. This guards the boundary.
    expect(matchesExclude("node_modules\\foo", [m("**/node_modules")])).toBe(false);
  });

  it("matches deeper paths via **", () => {
    expect(matchesExclude("a/b/c/dist/out.js", [m("**/dist")])).toBe(true);
  });
});

// ─── ActiveFileRevealer (3_2) ──────────────────────────────────────

describe("ActiveFileRevealer", () => {
  let posts: RevealInFileTreeMessage[];
  let revealer: ActiveFileRevealer | null;

  beforeEach(() => {
    __resetAll();
    __setWorkspaceFolders([{ uri: { fsPath: "/work" } }]);
    posts = [];
    revealer = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    revealer?.dispose();
  });

  function build(opts?: {
    mode?: "reveal" | "none" | "focusNoScroll";
    excludePatterns?: string[];
    workspaceRoot?: string | null;
  }) {
    const mode = opts?.mode ?? "reveal";
    const excludePatterns = opts?.excludePatterns ?? [];
    const root = opts?.workspaceRoot === undefined ? "/work" : opts.workspaceRoot;
    revealer = new ActiveFileRevealer(
      () => root,
      (msg) => posts.push(msg),
      () => ({ mode, excludePatterns }),
    );
    return revealer;
  }

  function fileTab(fsPath: string) {
    return { input: new TabInputText({ scheme: "file", fsPath }), isActive: true };
  }

  it("posts a reveal message for an in-workspace file after the debounce", () => {
    build();
    __setActiveTab(fileTab("/work/src/foo.ts"));
    expect(posts).toHaveLength(0); // not yet — debounce pending
    vi.advanceTimersByTime(100);
    expect(posts).toEqual([
      {
        type: "reveal-in-file-tree",
        absPath: "/work/src/foo.ts",
        focusNoScroll: false,
        source: "autoReveal",
      },
    ]);
  });

  it("coalesces rapid tab cycling to a single message carrying the final tab", () => {
    build();
    __setActiveTab(fileTab("/work/a.ts"));
    vi.advanceTimersByTime(40);
    __setActiveTab(fileTab("/work/b.ts"));
    vi.advanceTimersByTime(40);
    __setActiveTab(fileTab("/work/c.ts"));
    vi.advanceTimersByTime(40);
    __setActiveTab(fileTab("/work/d.ts"));
    vi.advanceTimersByTime(40);
    __setActiveTab(fileTab("/work/e.ts"));
    expect(posts).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1);
    expect(posts[0].absPath).toBe("/work/e.ts");
  });

  it("posts nothing when mode is 'none'", () => {
    build({ mode: "none" });
    __setActiveTab(fileTab("/work/foo.ts"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("posts focusNoScroll:true when mode is 'focusNoScroll'", () => {
    build({ mode: "focusNoScroll" });
    __setActiveTab(fileTab("/work/foo.ts"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1);
    expect(posts[0].focusNoScroll).toBe(true);
  });

  it("ignores non-file URI scheme", () => {
    build();
    __setActiveTab({
      input: new TabInputText({ scheme: "untitled", fsPath: "/work/draft.md" }),
      isActive: true,
    });
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("ignores unsupported TabInput shapes (diff)", () => {
    build();
    __setActiveTab({
      input: new TabInputTextDiff({ scheme: "file", fsPath: "/work/a.ts" }, { scheme: "file", fsPath: "/work/b.ts" }),
      isActive: true,
    });
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("accepts custom and notebook editor tabs with file: scheme", () => {
    build();
    __setActiveTab({
      input: new TabInputCustom({ scheme: "file", fsPath: "/work/img.png" }, "imagePreview"),
      isActive: true,
    });
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1);
    expect(posts[0].absPath).toBe("/work/img.png");
    posts.length = 0;

    __setActiveTab({
      input: new TabInputNotebook({ scheme: "file", fsPath: "/work/note.ipynb" }, "jupyter"),
      isActive: true,
    });
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1);
    expect(posts[0].absPath).toBe("/work/note.ipynb");
  });

  it("drops reveal silently when file is outside the first workspace folder", () => {
    build();
    __setActiveTab(fileTab("/elsewhere/foo.ts"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("accepts in-root files whose first path component starts with `..` (not the parent-dir sentinel)", () => {
    // Regression for W2: previously `rel.startsWith("..")` rejected legal folder
    // names like `..backup/`. Only the parent-dir sentinel should reject.
    build();
    __setActiveTab(fileTab("/work/..backup/notes.md"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1);
    expect(posts[0].absPath).toBe("/work/..backup/notes.md");
  });

  it("still rejects paths that traverse above root via the parent-dir sentinel", () => {
    build();
    __setActiveTab(fileTab("/foo.ts")); // path.relative('/work', '/foo.ts') === '../foo.ts'
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("drops reveal silently when there is no workspace folder", () => {
    build({ workspaceRoot: null });
    __setActiveTab(fileTab("/work/foo.ts"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("drops reveal when an ancestor matches an exclude pattern", () => {
    build({ excludePatterns: ["**/node_modules"] });
    __setActiveTab(fileTab("/work/node_modules/foo/index.js"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0);
  });

  it("rebuilds the matcher cache when autoRevealExclude config changes", () => {
    // First call uses initial patterns
    let patterns: string[] = ["**/dist"];
    revealer = new ActiveFileRevealer(
      () => "/work",
      (msg) => posts.push(msg),
      () => ({ mode: "reveal", excludePatterns: patterns }),
    );
    __setActiveTab(fileTab("/work/dist/out.js"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0); // excluded

    // Change the patterns + fire config change
    patterns = []; // no excludes
    __fireConfigChange(["anywhereTerminal.fileTree.autoRevealExclude"]);
    __setActiveTab(fileTab("/work/dist/out.js"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1); // now allowed through
  });

  it("survives structurally-invalid glob patterns by logging once and matching the valid ones", () => {
    // minimatch v10 is lenient about syntax (e.g. '[unclosed' becomes a literal),
    // so the only easy way to trigger the invalid-pattern branch is the empty string
    // (Minimatch.makeRe() returns false for it).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    build({ excludePatterns: ["", "**/node_modules"] });

    __setActiveTab(fileTab("/work/node_modules/x/y.ts"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(0); // valid pattern still applied

    __setActiveTab(fileTab("/work/src/foo.ts"));
    vi.advanceTimersByTime(100);
    expect(posts).toHaveLength(1); // not excluded

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("dispose removes both tab-change listeners and cancels pending timers", () => {
    build();
    __setActiveTab(fileTab("/work/foo.ts"));
    expect(__getTabChangeListenerCount()).toBe(2); // onDidChangeTabs + onDidChangeTabGroups
    revealer?.dispose();
    revealer = null;
    expect(__getTabChangeListenerCount()).toBe(0);
    vi.advanceTimersByTime(500);
    expect(posts).toHaveLength(0); // pending timer was cancelled
  });
});
