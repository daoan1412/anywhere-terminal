// src/pty/processTree.test.ts — Unit tests for the pure parser/BFS + OS wrapper.

import { describe, expect, it, vi } from "vitest";
import { collectDescendants, descendantPids, type ProcessTreeDeps, parseProcessTable } from "./processTree";

function makeDeps(overrides: Partial<ProcessTreeDeps> = {}): ProcessTreeDeps {
  return {
    exec: vi.fn(async () => ({ stdout: "", stderr: "" })),
    platform: "darwin",
    ...overrides,
  };
}

// A small forest:  1 → 2 → 4 ; 1 → 3 ; 2 → 5 ; 10 (unrelated)
const TABLE_TEXT = ["  2   1", "  3   1", "  4   2", "  5   2", " 10   9", "PID PPID", ""].join("\n");

describe("parseProcessTable", () => {
  it("parses `pid ppid` lines into a parent→children map, ignoring junk", () => {
    const table = parseProcessTable(TABLE_TEXT);
    expect(table.get(1)).toEqual([2, 3]);
    expect(table.get(2)).toEqual([4, 5]);
    expect(table.get(9)).toEqual([10]);
    // "PID PPID" header line and the trailing blank are skipped.
    expect(table.has(Number.NaN)).toBe(false);
  });

  it("returns an empty map for empty input", () => {
    expect(parseProcessTable("").size).toBe(0);
  });
});

describe("collectDescendants", () => {
  it("BFS-collects all transitive descendants of a root", () => {
    const table = parseProcessTable(TABLE_TEXT);
    expect(collectDescendants(1, table).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(collectDescendants(2, table).sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it("returns [] for a leaf / unknown pid", () => {
    const table = parseProcessTable(TABLE_TEXT);
    expect(collectDescendants(4, table)).toEqual([]);
    expect(collectDescendants(999, table)).toEqual([]);
  });

  it("does not loop on a cyclic table (defensive)", () => {
    const cyclic = new Map<number, number[]>([
      [1, [2]],
      [2, [1]],
    ]);
    expect(collectDescendants(1, cyclic)).toEqual([2]);
  });
});

describe("descendantPids: OS wrapper", () => {
  it("macOS calls `ps -axo pid=,ppid=` and returns the subtree", async () => {
    const deps = makeDeps({ platform: "darwin", exec: vi.fn(async () => ({ stdout: TABLE_TEXT, stderr: "" })) });
    const result = await descendantPids(1, deps);
    expect(result.sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(deps.exec).toHaveBeenCalledWith("ps", ["-axo", "pid=,ppid="], { timeout: 500 });
  });

  it("Linux calls `ps -eo pid=,ppid=`", async () => {
    const deps = makeDeps({ platform: "linux", exec: vi.fn(async () => ({ stdout: TABLE_TEXT, stderr: "" })) });
    await descendantPids(2, deps);
    expect(deps.exec).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid="], { timeout: 500 });
  });

  it("returns [] on Windows without any IO", async () => {
    const deps = makeDeps({ platform: "win32" });
    expect(await descendantPids(1, deps)).toEqual([]);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns [] for an invalid pid without any IO", async () => {
    const deps = makeDeps();
    expect(await descendantPids(0, deps)).toEqual([]);
    expect(await descendantPids(-5, deps)).toEqual([]);
    expect(await descendantPids(Number.NaN, deps)).toEqual([]);
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns [] when ps throws (not installed / timeout)", async () => {
    const deps = makeDeps({
      platform: "darwin",
      exec: vi.fn(async () => {
        throw new Error("Command failed: ps");
      }),
    });
    expect(await descendantPids(1, deps)).toEqual([]);
  });
});
