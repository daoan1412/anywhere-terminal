// src/utils/shellEscape.test.ts — Cases covering POSIX shell quoting branches.
//
// Task 5_1: confirm the existing helper is the one used by both the file-tree
// drag-out path and the existing DragDropHandler. No new helper is introduced.

import { describe, expect, it } from "vitest";
import { escapePathForShell } from "./shellEscape";

describe("escapePathForShell", () => {
  it("simple-wraps a plain path (no quotes / no spaces)", () => {
    expect(escapePathForShell("/Users/alice/code/main.ts")).toBe("'/Users/alice/code/main.ts'");
  });

  it("simple-wraps a path containing spaces — no escaping needed inside single quotes", () => {
    expect(escapePathForShell("/Users/alice/My Documents/notes.md")).toBe("'/Users/alice/My Documents/notes.md'");
  });

  it("uses POSIX break-and-escape pattern when the path contains a single quote", () => {
    // `'\''` closes the current quote, emits an escaped quote, and re-opens.
    expect(escapePathForShell("/tmp/can't-touch-this.txt")).toBe("'/tmp/can'\\''t-touch-this.txt'");
  });

  it("uses ANSI-C $'...' quoting when the path contains BOTH single and double quotes", () => {
    expect(escapePathForShell(`/tmp/it's "complicated".log`)).toBe(`$'/tmp/it\\'s "complicated".log'`);
  });
});
