// src/commands/exportHelpers.test.ts — Unit tests for the pure helpers.

import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import type { TrackedCommand } from "../session/TrackedCommand";
import {
  applyAnsiPreference,
  defaultExportFilename,
  type FsLike,
  formatCommandBlock,
  preferenceFromExtension,
  sanitizeFilenameSegment,
  writeExportAtomically,
} from "./exportHelpers";

describe("sanitizeFilenameSegment", () => {
  it("passes through allowed chars", () => {
    expect(sanitizeFilenameSegment("Terminal_1.log-2")).toBe("Terminal_1.log-2");
  });

  it("replaces every disallowed char with underscore", () => {
    expect(sanitizeFilenameSegment("hello world!")).toBe("hello_world_");
    expect(sanitizeFilenameSegment("path/with/slash")).toBe("path_with_slash");
    expect(sanitizeFilenameSegment("colon:and?question")).toBe("colon_and_question");
  });

  it("collapses to 'terminal' on empty input", () => {
    expect(sanitizeFilenameSegment("")).toBe("terminal");
  });
});

describe("defaultExportFilename", () => {
  it("formats with YYYYMMDD-HHmmss timestamp and the chosen ext", () => {
    const stamp = new Date(2026, 4, 26, 14, 5, 9); // 2026-05-26 14:05:09 local
    expect(defaultExportFilename("Terminal 1", "txt", stamp)).toBe("Terminal_1-20260526-140509.txt");
  });

  it("zero-pads single digits", () => {
    const stamp = new Date(2026, 0, 1, 3, 7, 4); // Jan 1 03:07:04
    expect(defaultExportFilename("x", "txt", stamp)).toBe("x-20260101-030704.txt");
  });

  it("sanitizes the session name", () => {
    const stamp = new Date(2026, 4, 26, 0, 0, 0);
    // `~` is outside [A-Za-z0-9._-] and becomes `_`; same for `:`, ` `, `/`.
    expect(defaultExportFilename("zsh: ~/code/foo", "log", stamp)).toBe("zsh____code_foo-20260526-000000.log");
  });
});

describe("applyAnsiPreference", () => {
  it("strips SGR when preserveAnsi=false", () => {
    const colored = "\x1b[31mred text\x1b[0m";
    expect(applyAnsiPreference(colored, false)).toBe("red text");
  });

  it("leaves ANSI intact when preserveAnsi=true", () => {
    const colored = "\x1b[31mred text\x1b[0m";
    expect(applyAnsiPreference(colored, true)).toBe(colored);
  });

  it("is a no-op on plain text", () => {
    expect(applyAnsiPreference("hello", false)).toBe("hello");
    expect(applyAnsiPreference("hello", true)).toBe("hello");
  });
});

function makeCmd(overrides: Partial<TrackedCommand> = {}): TrackedCommand {
  return {
    id: "cmd-1",
    commandLine: "pnpm test",
    output: "all tests pass\n",
    exitCode: 0,
    cwd: "/srv/app",
    startedAt: 1000,
    endedAt: 2000,
    outputChars: 15,
    outputTruncated: false,
    ...overrides,
  };
}

describe("formatCommandBlock", () => {
  it("renders the canonical layout", () => {
    expect(formatCommandBlock(makeCmd())).toBe("$ pnpm test\n[exit 0] [cwd /srv/app]\n\nall tests pass\n");
  });

  it("renders ? for missing exit code / cwd", () => {
    const out = formatCommandBlock(makeCmd({ exitCode: null, cwd: null }));
    expect(out).toContain("[exit ?]");
    expect(out).toContain("[cwd ?]");
  });

  it("renders a fallback for an empty commandLine (nonce-rejected case)", () => {
    const out = formatCommandBlock(makeCmd({ commandLine: "" }));
    expect(out.startsWith("$ (command line not recorded)\n")).toBe(true);
  });

  it("appends a truncation footer when outputTruncated=true", () => {
    const cmd = makeCmd({
      output: "x".repeat(100_000),
      outputChars: 1_500_000,
      outputTruncated: true,
    });
    const out = formatCommandBlock(cmd);
    expect(out).toContain("[output truncated — produced 1500000 chars, captured 100000]");
  });
});

describe("preferenceFromExtension", () => {
  it("returns preserveAnsi=true for .ansi", () => {
    expect(preferenceFromExtension("/tmp/out.ansi")).toEqual({ preserveAnsi: true });
    expect(preferenceFromExtension("FOO.ANSI")).toEqual({ preserveAnsi: true });
  });

  it("returns preserveAnsi=false for .txt and .log", () => {
    expect(preferenceFromExtension("/tmp/out.txt")).toEqual({ preserveAnsi: false });
    expect(preferenceFromExtension("/tmp/out.log")).toEqual({ preserveAnsi: false });
  });

  it("defaults to stripped on unknown ext", () => {
    expect(preferenceFromExtension("/tmp/out.dat")).toEqual({ preserveAnsi: false });
  });
});

describe("writeExportAtomically", () => {
  function makeFs(): FsLike & {
    calls: Array<{ op: "write" | "rename" | "delete"; path: string; payload?: string }>;
    failRename?: boolean;
    failDelete?: boolean;
  } {
    const calls: Array<{ op: "write" | "rename" | "delete"; path: string; payload?: string }> = [];
    return {
      calls,
      async writeFile(uri, bytes) {
        calls.push({ op: "write", path: uri.fsPath, payload: Buffer.from(bytes).toString("utf8") });
      },
      async rename(src, dst) {
        if (this.failRename) {
          throw new Error("rename failed");
        }
        calls.push({ op: "rename", path: `${src.fsPath} -> ${dst.fsPath}` });
      },
      async delete(uri) {
        if (this.failDelete) {
          throw new Error("delete failed");
        }
        calls.push({ op: "delete", path: uri.fsPath });
      },
    };
  }

  it("writes to .tmp then renames atomically", async () => {
    const fs = makeFs();
    const target = vscode.Uri.file("/tmp/out.txt");
    await writeExportAtomically(target, "hello", fs);
    expect(fs.calls).toEqual([
      { op: "write", path: "/tmp/out.txt.tmp", payload: "hello" },
      { op: "rename", path: "/tmp/out.txt.tmp -> /tmp/out.txt" },
    ]);
  });

  it("deletes the .tmp orphan on rename failure and re-throws", async () => {
    const fs = makeFs();
    fs.failRename = true;
    const target = vscode.Uri.file("/tmp/out.txt");
    await expect(writeExportAtomically(target, "x", fs)).rejects.toThrow("rename failed");
    const ops = fs.calls.map((c) => c.op);
    expect(ops).toEqual(["write", "delete"]);
  });

  it("swallows .tmp cleanup failure and surfaces the original rename error", async () => {
    const fs = makeFs();
    fs.failRename = true;
    fs.failDelete = true;
    const target = vscode.Uri.file("/tmp/out.txt");
    // Even though delete also fails, the surfaced error must be the rename one.
    await expect(writeExportAtomically(target, "x", fs)).rejects.toThrow("rename failed");
  });

  it("encodes the payload as UTF-8 (non-ASCII content preserved)", async () => {
    const fs = makeFs();
    const target = vscode.Uri.file("/tmp/out.txt");
    await writeExportAtomically(target, "héllo — wörld", fs);
    expect(fs.calls[0].payload).toBe("héllo — wörld");
  });
});
