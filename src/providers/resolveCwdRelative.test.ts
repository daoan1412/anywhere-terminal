// src/providers/resolveCwdRelative.test.ts — Table-driven coverage for the
// cwd-fan-out algorithm. Examples mirror `design.md` D1 + the MODIFIED spec.

import { describe, expect, it } from "vitest";
import { resolveCwdRelative } from "./resolveCwdRelative";

interface Row {
  name: string;
  cwd: string;
  link: string;
  platform: NodeJS.Platform;
  expected: string[];
}

const rows: Row[] = [
  {
    name: "cwd-suffix duplicates link prefix → two candidates",
    cwd: "/x/y/a",
    link: "a/file.md",
    platform: "linux",
    expected: ["/x/y/a/a/file.md", "/x/y/a/file.md"],
  },
  {
    name: "VS Code source example: /home/common + common/file.md",
    cwd: "/home/common",
    link: "common/file.md",
    platform: "linux",
    expected: ["/home/common/common/file.md", "/home/common/file.md"],
  },
  {
    name: "no common suffix → single candidate",
    cwd: "/x/y",
    link: "a/file.md",
    platform: "linux",
    expected: ["/x/y/a/file.md"],
  },
  {
    name: "single-segment link short-circuits to plain join",
    cwd: "/x/y/a",
    link: "file.md",
    platform: "linux",
    expected: ["/x/y/a/file.md"],
  },
  {
    name: "trailing slash on cwd is normalized (filter Boolean)",
    cwd: "/x/y/a/",
    link: "a/file.md",
    platform: "linux",
    expected: ["/x/y/a/a/file.md", "/x/y/a/file.md"],
  },
  {
    name: "Windows case-insensitive segment compare",
    cwd: "C:\\X\\A",
    link: "a\\file.md",
    platform: "win32",
    expected: ["C:\\X\\A\\a\\file.md", "C:\\X\\A\\file.md"],
  },
  {
    name: "Windows mixed separators in link",
    cwd: "C:\\X\\A",
    link: "a/file.md",
    platform: "win32",
    expected: ["C:\\X\\A\\a\\file.md", "C:\\X\\A\\file.md"],
  },
  {
    name: "two-segment overlap — link prefix matches cwd tail in reverse",
    // cwdParts reversed = [b, a, x]; linkParts = [b, a, file].
    // Both sequences match at index 0 (b=b) and index 1 (a=a), so the
    // algorithm strips up to two leading link segments, producing 3 candidates.
    cwd: "/x/a/b",
    link: "b/a/file",
    platform: "linux",
    expected: ["/x/a/b/b/a/file", "/x/a/b/a/file", "/x/a/b/file"],
  },
  {
    name: "leading ./ on link",
    cwd: "/x/y",
    link: "./foo.md",
    platform: "linux",
    expected: ["/x/y/foo.md"],
  },
  {
    name: "leading ../ on link kept literally — resolver later rejects findFiles for traversal",
    cwd: "/x/y/a",
    link: "../foo.md",
    platform: "linux",
    expected: ["/x/y/foo.md"],
  },
];

describe("resolveCwdRelative — table", () => {
  for (const row of rows) {
    it(row.name, () => {
      expect(resolveCwdRelative(row.cwd, row.link, row.platform)).toEqual(row.expected);
    });
  }
});

describe("resolveCwdRelative — edges", () => {
  it("empty cwd → []", () => {
    expect(resolveCwdRelative("", "file.md", "linux")).toEqual([]);
  });

  it("non-absolute cwd → []", () => {
    expect(resolveCwdRelative("relative/cwd", "file.md", "linux")).toEqual([]);
  });

  it("undefined-coerced cwd via empty string → []", () => {
    expect(resolveCwdRelative(undefined as unknown as string, "file.md", "linux")).toEqual([]);
  });
});
