// src/webview/links/filePathParser.test.ts — Exhaustive parser test suite.

import { describe, expect, it } from "vitest";
import { detectFilePathLinks } from "./filePathParser";

function findByPath(results: ReturnType<typeof detectFilePathLinks>, path: string) {
  return results.find((r) => r.path === path);
}

describe("detectFilePathLinks: suffix forms", () => {
  it("bare path with separator", () => {
    const r = detectFilePathLinks("see src/foo.ts there", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("src/foo.ts");
    expect(r[0].text).toBe("src/foo.ts");
    expect(r[0].line).toBeUndefined();
    expect(r[0].col).toBeUndefined();
    expect(r[0].index).toBe(4);
  });

  it("path:N", () => {
    const r = detectFilePathLinks("error at src/foo.ts:42", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, text: "src/foo.ts:42" });
    expect(r[0].col).toBeUndefined();
  });

  it("path:N:C", () => {
    const r = detectFilePathLinks("at src/foo.ts:42:7 in", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, col: 7, text: "src/foo.ts:42:7" });
  });

  it("path:N.C", () => {
    const r = detectFilePathLinks("at src/foo.ts:42.7 in", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, col: 7 });
  });

  it("path(N,C) with comma", () => {
    const r = detectFilePathLinks("Foo.cs(42,7): error", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "Foo.cs", line: 42, col: 7, text: "Foo.cs(42,7)" });
  });

  it("path(N, C) with comma+space", () => {
    const r = detectFilePathLinks("Foo.cs(42, 7): error", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "Foo.cs", line: 42, col: 7 });
  });

  it("path(N:C) with colon", () => {
    const r = detectFilePathLinks("Foo.cs(42:7): error", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "Foo.cs", line: 42, col: 7 });
  });

  it("path[N,C] with bracket", () => {
    const r = detectFilePathLinks("Foo.cs[42,7]: error", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "Foo.cs", line: 42, col: 7 });
  });

  it('Python traceback: File "x.py", line 42, column 7', () => {
    const r = detectFilePathLinks('  File "src/foo.py", line 42, column 7, in handler', "posix");
    const py = findByPath(r, "src/foo.py");
    expect(py).toBeDefined();
    expect(py).toMatchObject({ line: 42, col: 7 });
    expect(py!.text).toContain("line 42");
  });

  it('Python traceback: "x.py", line 42', () => {
    const r = detectFilePathLinks('Found at "src/foo.py", line 42', "posix");
    const py = findByPath(r, "src/foo.py");
    expect(py).toBeDefined();
    expect(py).toMatchObject({ line: 42 });
    expect(py!.col).toBeUndefined();
  });

  it('Python compact: "x.py":42:7', () => {
    const r = detectFilePathLinks('found "src/foo.py":42:7 here', "posix");
    const py = findByPath(r, "src/foo.py");
    expect(py).toBeDefined();
    expect(py).toMatchObject({ line: 42, col: 7 });
  });

  it("GitHub-style permalink: path#L42", () => {
    const r = detectFilePathLinks("see src/foo.ts#L42 for context", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, text: "src/foo.ts#L42" });
    expect(r[0].col).toBeUndefined();
  });

  it("GitHub-style permalink without L: path#42", () => {
    const r = detectFilePathLinks("see src/foo.ts#42", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, text: "src/foo.ts#42" });
  });

  it("line range path:N-M takes the FIRST line and underlines the full suffix", () => {
    // Ripgrep multi-line output / agent narration ("HoverPreviewPopup.ts:257-258").
    // The popup's focusLine scrolls to the start of the range; the range end
    // is informational only. The matched text MUST include `-M` so the link
    // underline doesn't leave the tail unlinked on screen.
    const r = detectFilePathLinks("see HoverPreviewPopup.ts:257-258 here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "HoverPreviewPopup.ts", line: 257, text: "HoverPreviewPopup.ts:257-258" });
    expect(r[0].col).toBeUndefined();
  });

  it("GitHub line range path#L42-L43 takes the first line", () => {
    const r = detectFilePathLinks("see src/foo.ts#L42-L43 for context", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, text: "src/foo.ts#L42-L43" });
  });

  it("GitHub line range without trailing L: path#L42-43", () => {
    const r = detectFilePathLinks("see src/foo.ts#L42-43", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, text: "src/foo.ts#L42-43" });
  });

  it("Claude CLI tool-call narration: Read(<path> · lines N-M)", () => {
    // Format emitted by claude-code agent transcripts when summarizing tool
    // calls. The middle-dot (U+00B7) + literal "lines" + range is novel — no
    // other compiler / formatter produces it.
    const input =
      "Read(/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/HoverPreviewPopup.test.ts · lines 180-299)";
    const r = detectFilePathLinks(input, "posix");
    const target = findByPath(
      r,
      "/Users/huybuidac/Projects/ai-oss/anywhere-terminal/src/webview/links/HoverPreviewPopup.test.ts",
    );
    expect(target).toBeDefined();
    expect(target).toMatchObject({ line: 180 });
    expect(target!.col).toBeUndefined();
  });

  it("Claude CLI singular: Edit(<path> · line N)", () => {
    const r = detectFilePathLinks("Edit(/abs/foo.ts · line 42)", "posix");
    const target = findByPath(r, "/abs/foo.ts");
    expect(target).toBeDefined();
    expect(target).toMatchObject({ line: 42 });
  });
});

describe("detectFilePathLinks: ignores web URLs (but claims file://)", () => {
  // `file:` was previously in this list; per the updated spec the detector
  // now claims `file://` URIs and hands them to the resolver (which decodes
  // via `vscode.Uri.parse`). Web URLs remain handled by xterm's WebLinksAddon.
  it.each([
    "https://example.com/file.ts",
    "http://example.com:8080/page",
    "ftp://server/path",
    "mailto:test@example.com",
    "ssh://host:22/repo",
    "git://github.com/foo/bar.git",
  ])("does not detect %s", (url) => {
    const r = detectFilePathLinks(`see ${url} for details`, "posix");
    expect(
      r.some(
        (x) =>
          x.path.startsWith("http") ||
          x.path.startsWith("ftp") ||
          x.path.startsWith("ssh:") ||
          x.path.startsWith("git:") ||
          x.path.startsWith("mailto:"),
      ),
    ).toBe(false);
  });
});

describe("detectFilePathLinks: broadened charset (design D3)", () => {
  it("# in path segment", () => {
    const r = detectFilePathLinks("touch /Users/me/repo#main/file.ts now", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/me/repo#main/file.ts");
  });

  it("& in path segment", () => {
    const r = detectFilePathLinks("ls /Users/me/repo&main/file.ts", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/me/repo&main/file.ts");
  });

  it("percent-encoded segment in path", () => {
    const r = detectFilePathLinks("see /Users/me/foo%20bar/file.md", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/me/foo%20bar/file.md");
  });

  it("non-ASCII letters (accents)", () => {
    const r = detectFilePathLinks("open /Users/huy/projects/à/file.md", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/huy/projects/à/file.md");
  });

  it("non-ASCII letters (CJK)", () => {
    const r = detectFilePathLinks("open /Users/huy/projects/项目/file.md", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/huy/projects/项目/file.md");
  });

  it("tilde-prefixed path retained as-is (resolver expands)", () => {
    const r = detectFilePathLinks("open ~/foo.md please", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("~/foo.md");
  });

  it("file:// URI claimed by detector", () => {
    const r = detectFilePathLinks("see file:///abs/file.md here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("file:///abs/file.md");
  });
});

describe("detectFilePathLinks: negative — broadened charset noise filters", () => {
  it("Version=1.2.3.4 rejected (identifier=value heuristic)", () => {
    expect(detectFilePathLinks("Version=1.2.3.4 released", "posix")).toEqual([]);
  });

  it("LOG_LEVEL=info rejected (identifier=value heuristic, no extension)", () => {
    expect(detectFilePathLinks("env LOG_LEVEL=info more", "posix")).toEqual([]);
  });

  it("package@1.2.3 rejected (identifier@version heuristic)", () => {
    expect(detectFilePathLinks("npm install react@18.2.0", "posix")).toEqual([]);
  });

  it("patch-file names with @version survive the heuristic", () => {
    // `react@18.2.0.patch` is a legitimate filename (e.g. from patch-package).
    // The end-of-string anchor on the @version heuristic preserves these.
    const r = detectFilePathLinks("applying react@18.2.0.patch...", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("react@18.2.0.patch");
  });

  it("https:// still rejected by URL_SCHEME_REGEX", () => {
    expect(detectFilePathLinks("visit https://example.com/x", "posix")).toEqual([]);
  });

  it("paren-bracketed bare path matches inner path only", () => {
    const r = detectFilePathLinks("note (/Users/me/file.ts) here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/me/file.ts");
    expect(r[0].text).not.toContain("(");
    expect(r[0].text).not.toContain(")");
  });

  it("path with internal space (unquoted) splits at the space", () => {
    // `[^\s'"<>(){}\[\]|]+` excludes whitespace, so the body breaks at the space.
    // Either side may still match if it independently looks like a file.
    const r = detectFilePathLinks("see /Users/Bob Smith/file.ts here", "posix");
    // `/Users/Bob` has `/` → looksLikeFile true; `Smith/file.ts` lacks a leading
    // boundary char (preceded by space), so it's also matched independently.
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.path === "/Users/Bob Smith/file.ts")).toBe(false);
  });
});

describe("detectFilePathLinks: ignores prose & numbers", () => {
  it.each([
    "the time is 12:34",
    "version 1.2.3 released",
    "exit code: 0",
    "tests passed: 42",
    "lorem ipsum dolor sit amet",
    "1234567890",
    "    ",
  ])("emits nothing for %s", (line) => {
    expect(detectFilePathLinks(line, "posix")).toEqual([]);
  });

  it("does not detect a bare extensionless word", () => {
    const r = detectFilePathLinks("tool printed something", "posix");
    expect(r).toEqual([]);
  });

  it("does not match a single-letter prefix version like 1.2.3", () => {
    const r = detectFilePathLinks("v1.2.3", "posix");
    expect(r).toEqual([]);
  });

  it("does not match paths with trailing slash (directory indicator)", () => {
    // Folder paths like `external-research/` or `src/providers/` would
    // resolve to directories — opening them as files is misleading. The
    // parser refuses to emit a candidate so no underline is drawn.
    expect(detectFilePathLinks("see external-research/", "posix")).toEqual([]);
    expect(detectFilePathLinks("cd src/providers/", "posix")).toEqual([]);
    expect(detectFilePathLinks("nested foo/bar/baz/", "posix")).toEqual([]);
  });

  it("does not match Windows-style trailing backslash directories", () => {
    expect(detectFilePathLinks("see src\\providers\\", "win32")).toEqual([]);
  });

  it("rejects file-shaped paths with trailing slash (e.g. `foo.ts/`)", () => {
    // A trailing slash on a file-looking name still means "directory" by
    // convention (e.g. a typo or rsync-style explicit dir). Refuse to highlight.
    expect(detectFilePathLinks("see foo.ts/", "posix")).toEqual([]);
    expect(detectFilePathLinks("at src/util.ts/", "posix")).toEqual([]);
  });
});

describe("detectFilePathLinks: boundary punctuation", () => {
  it("strips trailing period from bare path", () => {
    const r = detectFilePathLinks("Open src/foo.ts.", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("src/foo.ts");
    expect(r[0].text).toBe("src/foo.ts");
  });

  it("strips trailing comma from bare path", () => {
    const r = detectFilePathLinks("see src/foo.ts, then run", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("src/foo.ts");
  });

  it("does not include closing paren after suffix", () => {
    const r = detectFilePathLinks("at (src/foo.ts:42)", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42 });
    expect(r[0].text).not.toContain(")");
  });

  it("handles path inside quotes", () => {
    const r = detectFilePathLinks('use "src/foo.ts" here', "posix");
    const m = findByPath(r, "src/foo.ts");
    expect(m).toBeDefined();
  });
});

describe("detectFilePathLinks: performance caps", () => {
  it("returns [] for line longer than 2000 chars", () => {
    const huge = `/a.ts ${"x".repeat(2010)}`;
    expect(detectFilePathLinks(huge, "posix")).toEqual([]);
  });

  it("caps results at 10", () => {
    const parts = Array.from({ length: 15 }, (_, i) => `src/foo${i}.ts`).join(" ");
    const r = detectFilePathLinks(parts, "posix");
    expect(r).toHaveLength(10);
  });
});

describe("detectFilePathLinks: platform branch", () => {
  it("detects POSIX absolute path", () => {
    const r = detectFilePathLinks("err /usr/lib/foo.so:42", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "/usr/lib/foo.so", line: 42 });
  });

  it("detects Windows path with drive and backslash", () => {
    const r = detectFilePathLinks(String.raw`err C:\Users\foo\bar.ts:42 next`, "win32");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: String.raw`C:\Users\foo\bar.ts`, line: 42 });
  });

  it("Windows treats backslash as separator", () => {
    const r = detectFilePathLinks(String.raw`hit src\foo.ts here`, "win32");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe(String.raw`src\foo.ts`);
  });

  it("POSIX detects a Windows-style backslash path mid-line", () => {
    // After the body broadening (design D3), the path body accepts any
    // non-whitespace non-delimiter char including `\` on both platforms.
    // POSIX terminals occasionally surface Windows-style paths (pasted,
    // cat'd from a log) and clicking them is what the user expects.
    const r = detectFilePathLinks(String.raw`hit src\foo.ts here`, "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe(String.raw`src\foo.ts`);
  });
});

describe("detectFilePathLinks: dedup on overlap", () => {
  it('dedups bare "x.py" against Python verbose form (longer wins)', () => {
    const line = '  File "src/foo.py", line 42, in handler';
    const r = detectFilePathLinks(line, "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("src/foo.py");
    expect(r[0].text).toContain("line 42");
  });

  it("dedups suffixed against bare on same span", () => {
    const r = detectFilePathLinks("at src/foo.ts:42 here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("src/foo.ts:42");
  });

  it("keeps non-overlapping detections separately", () => {
    const r = detectFilePathLinks("foo src/a.ts:1 bar src/b.ts:2 baz", "posix");
    expect(r).toHaveLength(2);
    expect(r[0].path).toBe("src/a.ts");
    expect(r[1].path).toBe("src/b.ts");
  });
});

describe("detectFilePathLinks: AI-tool @mention prefix", () => {
  // Claude Code / Codex / OpenCode / Cursor / Cline convention: `@filepath`
  // introduces a file reference. The `@` is stripped from the resolved path
  // (so the resolver sees `docs/foo.md`, not `@docs/foo.md`) but stays in the
  // visible link text so the underline covers what the user typed.
  it("strips leading @ from relative path; text keeps the @", () => {
    const r = detectFilePathLinks("read @docs/external-research/fig-style.md please", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("docs/external-research/fig-style.md");
    expect(r[0].text).toBe("@docs/external-research/fig-style.md");
  });

  it("strips @ in suffixed form, preserves line number", () => {
    const r = detectFilePathLinks("see @src/foo.ts:42 here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      path: "src/foo.ts",
      line: 42,
      text: "@src/foo.ts:42",
    });
  });

  it("strips @ on Cline-style absolute mention `@/abs/path.md`", () => {
    const r = detectFilePathLinks("open @/Users/me/notes/x.md now", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("/Users/me/notes/x.md");
    expect(r[0].text).toBe("@/Users/me/notes/x.md");
  });

  it("rejects @scope/pkg npm-style mention (no extension)", () => {
    // `npm install @types/node` should not produce a clickable underline that
    // resolves to a non-existent `types/node` path.
    expect(detectFilePathLinks("npm install @types/node", "posix")).toEqual([]);
    expect(detectFilePathLinks("install @scope/package here", "posix")).toEqual([]);
  });

  it("rejects bare @username social mention (no separator, no extension)", () => {
    expect(detectFilePathLinks("ping @huybuidac on slack", "posix")).toEqual([]);
  });

  it("does not treat mid-token @ as mention (email `user@example.com` unchanged)", () => {
    // Boundary regex requires `@` to follow whitespace/start/quote/paren, so
    // `user@example.com` starts the match at `u`, not at `@`. The strip path
    // only runs when finalPath starts with `@`, which it doesn't here.
    // Email has no `/` and `.com` looks like an extension; `looksLikeFile`
    // accepts it as a bare-extension file but that's pre-existing behavior we
    // aren't changing — only assert the @-strip isn't triggered.
    const r = detectFilePathLinks("contact user@example.com today", "posix");
    expect(r.every((x) => !x.path.startsWith("@"))).toBe(true);
  });

  it("@ inside path token (npm scope inside real path) is preserved", () => {
    // `node_modules/@types/node/index.d.ts` — `@types` is mid-token, not at
    // the start. Strip logic must not touch it.
    const r = detectFilePathLinks("see node_modules/@types/node/index.d.ts here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("node_modules/@types/node/index.d.ts");
    expect(r[0].text).toBe("node_modules/@types/node/index.d.ts");
  });

  it("@ inside parens is stripped (Claude tool-call narration `(@foo.md)`)", () => {
    const r = detectFilePathLinks("note (@docs/foo.md) here", "posix");
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("docs/foo.md");
    expect(r[0].text).toBe("@docs/foo.md");
  });

  it("lone `@` produces no match", () => {
    expect(detectFilePathLinks("just @ a symbol", "posix")).toEqual([]);
  });
});

describe("detectFilePathLinks: shape contract", () => {
  it("each result has text, index, path, optional line/col", () => {
    const r = detectFilePathLinks("at src/foo.ts:42:7 in", "posix");
    expect(r[0]).toEqual({
      text: "src/foo.ts:42:7",
      index: 3,
      path: "src/foo.ts",
      line: 42,
      col: 7,
    });
  });

  it("text and index are consistent — lineText[index..index+text.length] === text", () => {
    const line = "prefix /a/b.ts:1 suffix";
    const r = detectFilePathLinks(line, "posix");
    expect(r).toHaveLength(1);
    const slice = line.slice(r[0].index, r[0].index + r[0].text.length);
    expect(slice).toBe(r[0].text);
  });
});
