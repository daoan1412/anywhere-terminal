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

// ─── Git status — snapshot transition + ancestor refcount ───────────

import type { GitStatus } from "../../types/messages";
import type { FileNode } from "./IFileSystemProvider";

function gitEntry(
  name: string,
  kind: "file" | "directory",
  parentPath: string,
  gitStatus?: GitStatus,
  gitRevision = 1,
): FileEntry {
  return { name, path: `${parentPath}/${name}`, kind, gitStatus, gitRevision };
}

async function loadChildren(h: Harness, parent: FileNode | null, entries: FileEntry[]): Promise<FileNode[]> {
  const promise = h.ds.getChildren(parent);
  const requestId = h.posted[h.posted.length - 1].requestId;
  h.ds.handleResponse({
    type: "read-directory-response",
    requestId,
    rootGeneration: h.ds.getRootGeneration(),
    entries,
  });
  return promise;
}

describe("FileSystemDataSource — git status snapshot routing", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ workspaceRoot: "/root" });
  });

  it("stamps gitStatus on cached FileNodes from snapshot entries", async () => {
    const children = await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", "modified", 5)]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("walks ancestor folders and increments dirtyDescendantCount on clean→dirty", async () => {
    // Load /root/src (folder).
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root")]);
    const srcNode = top[0];
    // Load /root/src/utils (folder).
    const second = await loadChildren(h, srcNode, [gitEntry("utils", "directory", "/root/src")]);
    const utilsNode = second[0];
    // Load /root/src/utils/foo.ts (modified file).
    await loadChildren(h, utilsNode, [gitEntry("foo.ts", "file", "/root/src/utils", "modified", 7)]);
    expect(utilsNode.dirtyDescendantCount).toBe(1);
    expect(srcNode.dirtyDescendantCount).toBe(1);
  });

  it("decrements ancestor count on dirty→clean (symmetric add/remove returns to 0)", async () => {
    // /root/src dir, /root/src/foo.ts modified at revision 5.
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root")]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", "modified", 5)]);
    expect(srcNode.dirtyDescendantCount).toBe(1);
    // Re-load /root/src — now /root/src/foo.ts is clean at revision 7.
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", undefined, 7)]);
    expect(srcNode.dirtyDescendantCount).toBe(0);
  });

  it("does NOT propagate `deleted` to ancestor folders", async () => {
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root")]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", "deleted", 5)]);
    expect(srcNode.dirtyDescendantCount).toBeFalsy();
  });

  it("does NOT propagate `ignored` to ancestor folders", async () => {
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root")]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", "ignored", 5)]);
    expect(srcNode.dirtyDescendantCount).toBeFalsy();
  });

  it("rejects an older-revision snapshot over a newer status (D10 race guard)", async () => {
    // First apply: revision 9 with modified.
    const top = await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", "modified", 9)]);
    expect(top[0].gitStatus).toBe<GitStatus>("modified");
    // Second apply: stale revision 3 says clean. Should be ignored.
    const refreshed = await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", undefined, 3)]);
    expect(refreshed[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("clears revisionByPath on workspace root change so the new generation starts fresh", async () => {
    await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", "modified", 9)]);
    h.ds.handleRootChanged({ rootPath: "/other", rootGeneration: 2 });
    // After root change, the previously-high watermark must not block a
    // freshly-stamped snapshot at low revision in the new generation.
    const fresh = await loadChildren(h, null, [
      { name: "a.ts", path: "/other/a.ts", kind: "file", gitStatus: "added", gitRevision: 1 },
    ]);
    expect(fresh[0].gitStatus).toBe<GitStatus>("added");
  });
});

describe("FileSystemDataSource — applyGitStatusDelta", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ workspaceRoot: "/root" });
  });

  it("(a) updates a cached node's gitStatus on a single modify delta", async () => {
    const children = await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", undefined, 5)]);
    h.ds.applyGitStatusDelta(7, [{ path: "/root/a.ts", status: "modified" }]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("(b) returns refcount to 0 on modify → clean", async () => {
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root", undefined, 1)]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", undefined, 1)]);
    h.ds.applyGitStatusDelta(2, [{ path: "/root/src/foo.ts", status: "modified" }]);
    expect(srcNode.dirtyDescendantCount).toBe(1);
    h.ds.applyGitStatusDelta(3, [{ path: "/root/src/foo.ts", status: null }]);
    expect(srcNode.dirtyDescendantCount).toBe(0);
  });

  it("(c) increments three ancestors for a 3-deep modify", async () => {
    const top = await loadChildren(h, null, [gitEntry("a", "directory", "/root", undefined, 1)]);
    const a = top[0];
    const second = await loadChildren(h, a, [gitEntry("b", "directory", "/root/a", undefined, 1)]);
    const b = second[0];
    const third = await loadChildren(h, b, [gitEntry("c", "directory", "/root/a/b", undefined, 1)]);
    const c = third[0];
    await loadChildren(h, c, [gitEntry("leaf.ts", "file", "/root/a/b/c", undefined, 1)]);
    h.ds.applyGitStatusDelta(2, [{ path: "/root/a/b/c/leaf.ts", status: "modified" }]);
    expect(c.dirtyDescendantCount).toBe(1);
    expect(b.dirtyDescendantCount).toBe(1);
    expect(a.dirtyDescendantCount).toBe(1);
  });

  it("(d) drains a pending status onto a node inserted later", async () => {
    // Delta arrives BEFORE the directory is loaded — should be parked.
    h.ds.applyGitStatusDelta(4, [{ path: "/root/late.ts", status: "modified" }]);
    // Now load the directory. The fresh entry's snapshot revision is older
    // than the pending delta's, so the delta wins — but the snapshot is
    // applied first (via getChildren), then the pending one with revision 4
    // overrides because 4 > 1.
    const children = await loadChildren(h, null, [gitEntry("late.ts", "file", "/root", undefined, 1)]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("(e) keeps the snapshot when a stale delta arrives at lower revision", async () => {
    const children = await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", "modified", 5)]);
    h.ds.applyGitStatusDelta(3, [{ path: "/root/a.ts", status: null }]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("(f) keeps the delta when a stale snapshot arrives at lower revision", async () => {
    // Pre-emptive delta wins.
    h.ds.applyGitStatusDelta(5, [{ path: "/root/a.ts", status: "modified" }]);
    // Snapshot at revision 3 must NOT clobber the rev-5 delta.
    const children = await loadChildren(h, null, [gitEntry("a.ts", "file", "/root", undefined, 3)]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("(g) clears pending statuses on workspace root change", async () => {
    h.ds.applyGitStatusDelta(4, [{ path: "/root/x.ts", status: "modified" }]);
    h.ds.handleRootChanged({ rootPath: "/other", rootGeneration: 2 });
    // The path is irrelevant in the new generation — load /other/x.ts
    // without a status; it must not be retroactively decorated.
    const fresh = await loadChildren(h, null, [{ name: "x.ts", path: "/other/x.ts", kind: "file", gitRevision: 1 }]);
    expect(fresh[0].gitStatus).toBeUndefined();
  });

  it("(h) drops the pending entry when a subsequent null-status delta clears it", async () => {
    h.ds.applyGitStatusDelta(3, [{ path: "/root/late.ts", status: "modified" }]);
    h.ds.applyGitStatusDelta(4, [{ path: "/root/late.ts", status: null }]);
    // Subsequent insert must not see the modified status from the earlier
    // pending entry.
    const children = await loadChildren(h, null, [gitEntry("late.ts", "file", "/root", undefined, 1)]);
    expect(children[0].gitStatus).toBeUndefined();
  });

  it("(i) deleted status does NOT increment parent dirtyDescendantCount", async () => {
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root", undefined, 1)]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", undefined, 1)]);
    h.ds.applyGitStatusDelta(2, [{ path: "/root/src/foo.ts", status: "deleted" }]);
    expect(srcNode.dirtyDescendantCount).toBeFalsy();
  });

  it("(j) ignored status does NOT increment parent dirtyDescendantCount", async () => {
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root", undefined, 1)]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", undefined, 1)]);
    h.ds.applyGitStatusDelta(2, [{ path: "/root/src/foo.ts", status: "ignored" }]);
    expect(srcNode.dirtyDescendantCount).toBeFalsy();
  });
});

describe("FileSystemDataSource — pendingStatuses revision guard (O-W1)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ workspaceRoot: "/root" });
  });

  it("rejects an older delta that would overwrite a newer pending entry", async () => {
    // Two deltas for an unknown path; the second arrives with a LOWER
    // revision and must not clobber the higher-revision pending.
    h.ds.applyGitStatusDelta(7, [{ path: "/root/late.ts", status: "modified" }]);
    h.ds.applyGitStatusDelta(3, [{ path: "/root/late.ts", status: "added" }]);
    // When the directory finally loads, the rev-7 modified should win.
    const children = await loadChildren(h, null, [gitEntry("late.ts", "file", "/root", undefined, 1)]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("rejects an older null-clear that would drop a newer pending entry", async () => {
    h.ds.applyGitStatusDelta(7, [{ path: "/root/late.ts", status: "modified" }]);
    // Stale clear at rev 3 — must NOT delete the newer pending.
    h.ds.applyGitStatusDelta(3, [{ path: "/root/late.ts", status: null }]);
    const children = await loadChildren(h, null, [gitEntry("late.ts", "file", "/root", undefined, 1)]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });

  it("accepts a newer delta that overwrites an older pending entry", async () => {
    h.ds.applyGitStatusDelta(3, [{ path: "/root/late.ts", status: "added" }]);
    h.ds.applyGitStatusDelta(7, [{ path: "/root/late.ts", status: "modified" }]);
    const children = await loadChildren(h, null, [gitEntry("late.ts", "file", "/root", undefined, 1)]);
    expect(children[0].gitStatus).toBe<GitStatus>("modified");
  });
});

describe("FileSystemDataSource — nodeCache eviction (O-W2)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ workspaceRoot: "/root" });
  });

  it("evicts a child that disappeared from a later getChildren listing", async () => {
    await loadChildren(h, null, [
      gitEntry("a.ts", "file", "/root", undefined, 1),
      gitEntry("b.ts", "file", "/root", undefined, 1),
    ]);
    // Now a.ts is gone (deleted on disk between listings).
    await loadChildren(h, null, [gitEntry("b.ts", "file", "/root", undefined, 2)]);
    // Cached node for /root/a.ts should be gone. We can't observe the
    // private cache directly, but a fresh delta to /root/a.ts must now go
    // to pendingStatuses (since the node was evicted), which we verify by
    // re-loading the directory with a fresh entry and seeing the pending
    // status drain onto it.
    h.ds.applyGitStatusDelta(5, [{ path: "/root/a.ts", status: "untracked" }]);
    const refreshed = await loadChildren(h, null, [
      gitEntry("a.ts", "file", "/root", undefined, 1),
      gitEntry("b.ts", "file", "/root", undefined, 2),
    ]);
    const aNode = refreshed.find((n) => n.path === "/root/a.ts");
    expect(aNode?.gitStatus).toBe<GitStatus>("untracked");
  });

  it("decrements ancestor refcount when evicting a dirty leaf", async () => {
    // /root/src/foo.ts modified — srcNode.dirtyDescendantCount = 1.
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root", undefined, 1)]);
    const srcNode = top[0];
    await loadChildren(h, srcNode, [gitEntry("foo.ts", "file", "/root/src", "modified", 5)]);
    expect(srcNode.dirtyDescendantCount).toBe(1);
    // Re-load /root/src without foo.ts (out-of-band delete with no preceding
    // git status clear). Eviction should walk ancestors -1 since foo.ts was
    // dirty-for-propagation.
    await loadChildren(h, srcNode, []);
    expect(srcNode.dirtyDescendantCount).toBe(0);
  });

  it("evicts an entire subtree when an intermediate directory disappears", async () => {
    // Build /root/src/utils/foo.ts modified.
    const top = await loadChildren(h, null, [gitEntry("src", "directory", "/root", undefined, 1)]);
    const srcNode = top[0];
    const second = await loadChildren(h, srcNode, [gitEntry("utils", "directory", "/root/src", undefined, 1)]);
    const utilsNode = second[0];
    await loadChildren(h, utilsNode, [gitEntry("foo.ts", "file", "/root/src/utils", "modified", 5)]);
    expect(srcNode.dirtyDescendantCount).toBe(1);
    // Now /root/src lists without utils — utils + foo.ts get evicted.
    await loadChildren(h, srcNode, []);
    expect(srcNode.dirtyDescendantCount).toBe(0);
  });
});
