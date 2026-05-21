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
});

describe("detectFilePathLinks: ignores URLs", () => {
  it.each([
    "https://example.com/file.ts",
    "http://example.com:8080/page",
    "file:///home/user/x.py",
    "ftp://server/path",
    "mailto:test@example.com",
    "ssh://host:22/repo",
    "git://github.com/foo/bar.git",
  ])("does not detect %s", (url) => {
    const r = detectFilePathLinks(`see ${url} for details`, "posix");
    // The URL itself must not appear as a detected path.
    expect(
      r.some(
        (x) =>
          x.path.startsWith("http") ||
          x.path.startsWith("ftp") ||
          x.path.startsWith("file:") ||
          x.path.startsWith("ssh:") ||
          x.path.startsWith("git:") ||
          x.path.startsWith("mailto:"),
      ),
    ).toBe(false);
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

  it("POSIX does not match a Windows-style backslash path mid-line", () => {
    const r = detectFilePathLinks(String.raw`hit src\foo.ts here`, "posix");
    // POSIX regex path body excludes `\` — body breaks at backslash, and the
    // char after `\` is not a boundary char, so the regex can't restart at `f`.
    // Result: no detection. Users should run POSIX terminals with POSIX paths.
    expect(r).toEqual([]);
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
