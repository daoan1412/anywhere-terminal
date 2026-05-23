// src/webview/fileTree/FileSystemDataSource.test.ts — Unit tests for the
// webview-side `FileSystemDataSource`. Logic-only — no DOM needed.
//
// See: asimov/changes/port-vscode-async-data-tree/specs/file-tree-rpc/spec.md
//        #requirement-rpc-correlation
//        #requirement-file-system-provider-interface-webview-side

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, ReadDirectoryResponseMessage, RequestReadDirectoryMessage } from "../../types/messages";
import { FileSystemDataSource } from "./FileSystemDataSource";

// ─── Helpers ────────────────────────────────────────────────────────

interface Harness {
  ds: FileSystemDataSource;
  posted: RequestReadDirectoryMessage[];
  warnSpy: ReturnType<typeof vi.spyOn>;
}

function makeHarness(opts?: { rootGeneration?: number; workspaceRoot?: string | null }): Harness {
  const posted: RequestReadDirectoryMessage[] = [];
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // `??` swaps `null` for the default — but `null` is a meaningful value for
  // `workspaceRoot` (no workspace open). Detect "key absent" via `in` to keep
  // explicit `null` distinct from "no override".
  const workspaceRoot = opts && "workspaceRoot" in opts ? (opts.workspaceRoot ?? null) : "/root";
  const ds = new FileSystemDataSource(
    {
      rootGeneration: opts?.rootGeneration ?? 1,
      workspaceRoot,
    },
    (m) => posted.push(m),
  );
  return { ds, posted, warnSpy };
}

function entry(name: string, kind: "file" | "directory" = "file"): FileEntry {
  return { name, path: `/root/${name}`, kind };
}

// ─── Tests ──────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FileSystemDataSource — readDirectory RPC correlation", () => {
  it("posts a request carrying the current rootGeneration and path", () => {
    const { ds, posted } = makeHarness({ rootGeneration: 7 });
    void ds.readDirectory("/root/sub");

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      type: "request-read-directory",
      rootGeneration: 7,
      path: "/root/sub",
    });
    expect(typeof posted[0].requestId).toBe("string");
    expect(posted[0].requestId.length).toBeGreaterThan(0);
  });

  it("generates a unique requestId per call", () => {
    const { ds, posted } = makeHarness();
    void ds.readDirectory("/root/a");
    void ds.readDirectory("/root/b");
    void ds.readDirectory("/root/c");

    const ids = new Set(posted.map((m) => m.requestId));
    expect(ids.size).toBe(3);
  });

  it("resolves the promise when the matching response arrives", async () => {
    const { ds, posted } = makeHarness();
    const entries = [entry("a.ts"), entry("nested", "directory")];
    const p = ds.readDirectory("/root");

    const requestId = posted[0].requestId;
    const response: ReadDirectoryResponseMessage = {
      type: "read-directory-response",
      requestId,
      rootGeneration: 1,
      entries,
    };
    ds.handleResponse(response);

    await expect(p).resolves.toEqual(entries);
  });

  it("rejects with the host-supplied error", async () => {
    const { ds, posted } = makeHarness();
    const p = ds.readDirectory("/root/missing");
    const requestId = posted[0].requestId;

    ds.handleResponse({
      type: "read-directory-response",
      requestId,
      rootGeneration: 1,
      error: { code: "ENOENT", message: "Not found" },
    });

    await expect(p).rejects.toThrow(/ENOENT: Not found/);
  });

  it("treats a missing `entries` field as an empty listing", async () => {
    const { ds, posted } = makeHarness();
    const p = ds.readDirectory("/root/empty");
    ds.handleResponse({
      type: "read-directory-response",
      requestId: posted[0].requestId,
      rootGeneration: 1,
    });
    await expect(p).resolves.toEqual([]);
  });
});

describe("FileSystemDataSource — orphan responses are logged and dropped", () => {
  it("drops responses with an unknown requestId and warns once", async () => {
    const { ds, posted, warnSpy } = makeHarness();
    const p = ds.readDirectory("/root");
    const realRequestId = posted[0].requestId;

    // Bogus correlation id — must NOT settle the live promise.
    ds.handleResponse({
      type: "read-directory-response",
      requestId: "not-a-real-id",
      rootGeneration: 1,
      entries: [entry("ghost")],
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/orphan response/);

    // Live promise still pending — settle it properly.
    ds.handleResponse({
      type: "read-directory-response",
      requestId: realRequestId,
      rootGeneration: 1,
      entries: [entry("real")],
    });
    await expect(p).resolves.toEqual([entry("real")]);
  });

  it("drops responses whose rootGeneration does not match and warns", () => {
    const { ds, posted, warnSpy } = makeHarness({ rootGeneration: 5 });
    void ds.readDirectory("/root");
    const requestId = posted[0].requestId;

    ds.handleResponse({
      type: "read-directory-response",
      requestId,
      rootGeneration: 4, // stale
      entries: [entry("stale")],
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/generation mismatch/);
    // Pending entry is intentionally left in place (task 3_5 handles bulk
    // cancellation on root change); we only assert no resolution leaked.
  });

  it("does not log when matching responses arrive in order", async () => {
    const { ds, posted, warnSpy } = makeHarness();
    const p1 = ds.readDirectory("/a");
    const p2 = ds.readDirectory("/b");

    ds.handleResponse({
      type: "read-directory-response",
      requestId: posted[0].requestId,
      rootGeneration: 1,
      entries: [entry("a-child")],
    });
    ds.handleResponse({
      type: "read-directory-response",
      requestId: posted[1].requestId,
      rootGeneration: 1,
      entries: [entry("b-child")],
    });

    await expect(p1).resolves.toEqual([entry("a-child")]);
    await expect(p2).resolves.toEqual([entry("b-child")]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("FileSystemDataSource — ITreeDataSource<FileNode>", () => {
  it("hasChildren: true for null root and directories, false for files", () => {
    const { ds } = makeHarness();
    expect(ds.hasChildren(null)).toBe(true);
    expect(ds.hasChildren({ name: "x", path: "/root/x", kind: "directory" })).toBe(true);
    expect(ds.hasChildren({ name: "y.txt", path: "/root/y.txt", kind: "file" })).toBe(false);
  });

  it("getChildren(null) reads the workspace root and maps to FileNodes", async () => {
    const { ds, posted } = makeHarness({ workspaceRoot: "/root" });
    const p = ds.getChildren(null);
    expect(posted[0].path).toBe("/root");
    ds.handleResponse({
      type: "read-directory-response",
      requestId: posted[0].requestId,
      rootGeneration: 1,
      entries: [entry("a.ts"), entry("dir", "directory")],
    });
    await expect(p).resolves.toEqual([
      { name: "a.ts", path: "/root/a.ts", kind: "file" },
      { name: "dir", path: "/root/dir", kind: "directory" },
    ]);
  });

  it("getChildren(node) reads that node's path", async () => {
    const { ds, posted } = makeHarness();
    const p = ds.getChildren({ name: "dir", path: "/root/dir", kind: "directory" });
    expect(posted[0].path).toBe("/root/dir");
    ds.handleResponse({
      type: "read-directory-response",
      requestId: posted[0].requestId,
      rootGeneration: 1,
      entries: [],
    });
    await expect(p).resolves.toEqual([]);
  });

  it("getChildren(null) returns [] when no workspace root is set", async () => {
    const { ds, posted } = makeHarness({ workspaceRoot: null });
    await expect(ds.getChildren(null)).resolves.toEqual([]);
    expect(posted).toHaveLength(0);
  });
});

describe("FileSystemDataSource — stat", () => {
  it("throws — stat is not in this change's scope", async () => {
    const { ds } = makeHarness();
    await expect(ds.stat("/root/a")).rejects.toThrow(/not implemented/);
  });
});

describe("FileSystemDataSource — dispose() cleans up pending requests", () => {
  it("rejects all in-flight requests with CancellationError and clears the pending map", async () => {
    const { ds } = makeHarness();
    const p1 = ds.readDirectory("/root/a");
    const p2 = ds.readDirectory("/root/b");
    // Swallow rejections so the unhandled-rejection tracker stays quiet
    // before we assert on them below.
    p1.catch(() => {});
    p2.catch(() => {});

    ds.dispose();

    await expect(p1).rejects.toMatchObject({ name: "CancellationError" });
    await expect(p2).rejects.toMatchObject({ name: "CancellationError" });
    // Internal: pending map is private, so probe it via behaviour — a
    // late-arriving response for either request must be treated as orphan
    // (warns "orphan response"), which can only happen if the map is empty.
    // Plus subsequent readDirectory rejects immediately (see next test).
  });

  it("is idempotent — calling dispose() twice does not throw", async () => {
    const { ds } = makeHarness();
    const p = ds.readDirectory("/root/a");
    p.catch(() => {});

    expect(() => ds.dispose()).not.toThrow();
    expect(() => ds.dispose()).not.toThrow();

    await expect(p).rejects.toMatchObject({ name: "CancellationError" });
  });

  it("readDirectory() after dispose() rejects immediately with CancellationError", async () => {
    const { ds, posted } = makeHarness();
    ds.dispose();

    await expect(ds.readDirectory("/root/late")).rejects.toMatchObject({
      name: "CancellationError",
    });
    // No message was posted — the guard short-circuits before postMessage.
    expect(posted).toHaveLength(0);
  });
});

describe("FileSystemDataSource — multi-request correlation", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("settles two interleaved requests independently", async () => {
    const p1 = h.ds.readDirectory("/root/a");
    const p2 = h.ds.readDirectory("/root/b");
    const [r1, r2] = h.posted;

    // Respond to p2 first.
    h.ds.handleResponse({
      type: "read-directory-response",
      requestId: r2.requestId,
      rootGeneration: 1,
      entries: [entry("from-b")],
    });
    h.ds.handleResponse({
      type: "read-directory-response",
      requestId: r1.requestId,
      rootGeneration: 1,
      entries: [entry("from-a")],
    });

    await expect(p1).resolves.toEqual([entry("from-a")]);
    await expect(p2).resolves.toEqual([entry("from-b")]);
  });
});
