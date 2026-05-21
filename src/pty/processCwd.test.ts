// src/pty/processCwd.test.ts — Unit tests for processCwd.

import { describe, expect, it, vi } from "vitest";
import { type ProcessCwdDeps, queryProcessCwd } from "./processCwd";

function makeDeps(overrides: Partial<ProcessCwdDeps> = {}): ProcessCwdDeps {
  return {
    readlink: vi.fn(async () => "/should-not-be-called"),
    exec: vi.fn(async () => ({ stdout: "", stderr: "" })),
    platform: "linux",
    ...overrides,
  };
}

describe("queryProcessCwd: input validation", () => {
  it("returns undefined for pid <= 0", async () => {
    expect(await queryProcessCwd(0, makeDeps())).toBeUndefined();
    expect(await queryProcessCwd(-1, makeDeps())).toBeUndefined();
  });

  it("returns undefined for non-integer pid", async () => {
    expect(await queryProcessCwd(Number.NaN, makeDeps())).toBeUndefined();
    expect(await queryProcessCwd(3.14, makeDeps())).toBeUndefined();
    expect(await queryProcessCwd(Number.POSITIVE_INFINITY, makeDeps())).toBeUndefined();
  });

  it("does NOT call any IO for invalid pids", async () => {
    const deps = makeDeps();
    await queryProcessCwd(0, deps);
    expect(deps.readlink).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
  });
});

describe("queryProcessCwd: Linux", () => {
  it("readlinks /proc/<pid>/cwd and returns the result", async () => {
    const deps = makeDeps({
      platform: "linux",
      readlink: vi.fn(async () => "/home/me/proj"),
    });
    expect(await queryProcessCwd(12345, deps)).toBe("/home/me/proj");
    expect(deps.readlink).toHaveBeenCalledWith("/proc/12345/cwd");
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns undefined when readlink throws (process gone, permission denied)", async () => {
    const deps = makeDeps({
      platform: "linux",
      readlink: vi.fn(async () => {
        const err = new Error("ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });
});

describe("queryProcessCwd: macOS", () => {
  it("invokes lsof with the right args and parses the n<path> line", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => ({
        stdout: "p12345\nfcwd\nn/Users/me/proj\n",
        stderr: "",
      })),
    });
    expect(await queryProcessCwd(12345, deps)).toBe("/Users/me/proj");
    expect(deps.exec).toHaveBeenCalledWith("lsof", ["-a", "-p", "12345", "-d", "cwd", "-Fn"], { timeout: 500 });
    expect(deps.readlink).not.toHaveBeenCalled();
  });

  it("returns undefined when lsof output has no n-prefixed line", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => ({ stdout: "p12345\nfcwd\n", stderr: "" })),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("returns undefined when lsof throws (not installed, timeout, process gone)", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => {
        throw new Error("Command failed: lsof");
      }),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("trims trailing whitespace / \\r from the path", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => ({ stdout: "p12345\nfcwd\nn/Users/me/proj  \r\n", stderr: "" })),
    });
    expect(await queryProcessCwd(12345, deps)).toBe("/Users/me/proj");
  });

  it("picks the first n-prefixed line if there are multiple (defensive)", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => ({ stdout: "p12345\nfcwd\nn/first\nn/second\n", stderr: "" })),
    });
    expect(await queryProcessCwd(12345, deps)).toBe("/first");
  });
});

describe("queryProcessCwd: output sanitization", () => {
  it("Linux: rejects '<path> (deleted)' (process cwd was removed)", async () => {
    const deps = makeDeps({
      platform: "linux",
      readlink: vi.fn(async () => "/tmp/gone (deleted)"),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("Linux: rejects relative paths from /proc (defensive — should never happen, but…)", async () => {
    const deps = makeDeps({
      platform: "linux",
      readlink: vi.fn(async () => "relative/path"),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("Linux: rejects empty readlink result", async () => {
    const deps = makeDeps({ platform: "linux", readlink: vi.fn(async () => "") });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("Linux: rejects path containing control bytes / null byte", async () => {
    const deps = makeDeps({ platform: "linux", readlink: vi.fn(async () => "/foo\0bar") });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();

    const deps2 = makeDeps({ platform: "linux", readlink: vi.fn(async () => "/foo\x1bbar") });
    expect(await queryProcessCwd(12345, deps2)).toBeUndefined();
  });

  it("macOS: rejects when lsof n-line is not an absolute path (warning text masquerading)", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => ({ stdout: "p12345\nfcwd\nnot a real path\n", stderr: "" })),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("macOS: rejects when lsof returns a path with embedded null byte", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => ({ stdout: "p12345\nfcwd\nn/foo\0bar\n", stderr: "" })),
    });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("accepts a valid POSIX-absolute path on Linux", async () => {
    const deps = makeDeps({ platform: "linux", readlink: vi.fn(async () => "/Users/me/proj") });
    expect(await queryProcessCwd(12345, deps)).toBe("/Users/me/proj");
  });
});

describe("queryProcessCwd: unsupported platforms", () => {
  it("returns undefined on Windows", async () => {
    const deps = makeDeps({ platform: "win32" });
    expect(await queryProcessCwd(12345, deps)).toBeUndefined();
  });

  it("returns undefined on freebsd/openbsd/etc.", async () => {
    expect(await queryProcessCwd(12345, makeDeps({ platform: "freebsd" }))).toBeUndefined();
    expect(await queryProcessCwd(12345, makeDeps({ platform: "openbsd" }))).toBeUndefined();
  });

  it("does NOT call any IO on unsupported platforms", async () => {
    const deps = makeDeps({ platform: "win32" });
    await queryProcessCwd(12345, deps);
    expect(deps.readlink).not.toHaveBeenCalled();
    expect(deps.exec).not.toHaveBeenCalled();
  });
});
