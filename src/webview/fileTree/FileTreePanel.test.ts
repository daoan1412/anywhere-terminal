// @vitest-environment jsdom

// Confirms the panel's two contract points:
//   - empty-state when no workspace folder is open
//   - click-to-open file rows post `OpenFileMessage` with both `path` AND a
//     non-null `sessionId` resolved via the injected `getActiveSessionId()`
//     helper (mirroring DragDropHandler — see design.md Risk Map).
//
// The Tree's listWidget needs `ResizeObserver` and `matchMedia` shims under
// JSDOM (see `src/test/vendor-import.test.ts`).

import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CancelFileTreeSearchMessage,
  OpenFileMessage,
  RequestFileTreeSearchMessage,
  RequestReadDirectoryMessage,
  RequestSetFileTreePositionMessage,
} from "../../types/messages";
import { FileTreePanel } from "./FileTreePanel";
import type { FileNode } from "./IFileSystemProvider";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
  if (typeof globalThis.matchMedia === "undefined") {
    globalThis.matchMedia = (() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
  }
});

type AnyMsg =
  | RequestReadDirectoryMessage
  | OpenFileMessage
  | RequestSetFileTreePositionMessage
  | RequestFileTreeSearchMessage
  | CancelFileTreeSearchMessage
  | import("../../types/messages").RequestSubscribeFsChangesMessage
  | import("../../types/messages").RequestUnsubscribeFsChangesMessage;

function createHost(): HTMLElement {
  const host = document.createElement("div");
  host.style.height = "200px";
  host.style.width = "300px";
  document.body.appendChild(host);
  return host;
}

describe("FileTreePanel", () => {
  it("renders empty-state placeholder when workspaceRoot is null", () => {
    const host = createHost();
    const panel = new FileTreePanel({
      host,
      workspaceRoot: null,
      rootGeneration: 0,
      getActiveSessionId: () => "any-session",
      postMessage: () => {},
    });

    const empty = host.querySelector(".file-tree-empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No folder open");
    // No Tree should have been constructed — host itself is NOT stamped with role="tree".
    expect(host.getAttribute("role")).toBeNull();

    panel.dispose();
  });

  it("posts OpenFileMessage with both path AND sessionId on file activation", () => {
    const host = createHost();
    const posted: AnyMsg[] = [];

    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 5,
      getActiveSessionId: () => "sess-A",
      postMessage: (m) => posted.push(m),
    });

    panel.handleActivate({
      name: "main.ts",
      path: "/workspace/src/main.ts",
      kind: "file",
    });

    const openFileMsgs = posted.filter((m): m is OpenFileMessage => m.type === "openFile");
    expect(openFileMsgs).toHaveLength(1);
    expect(openFileMsgs[0]).toMatchObject({
      type: "openFile",
      path: "/workspace/src/main.ts",
      sessionId: "sess-A",
    });

    panel.dispose();
  });

  it("does NOT post OpenFileMessage when getActiveSessionId returns null", () => {
    const host = createHost();
    const posted: AnyMsg[] = [];

    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 5,
      getActiveSessionId: () => null,
      postMessage: (m) => posted.push(m),
    });

    panel.handleActivate({
      name: "main.ts",
      path: "/workspace/src/main.ts",
      kind: "file",
    });

    const openFileMsgs = posted.filter((m): m is OpenFileMessage => m.type === "openFile");
    expect(openFileMsgs).toHaveLength(0);

    panel.dispose();
  });

  it("does NOT activate synthetic search footer rows", () => {
    const host = createHost();
    const posted: AnyMsg[] = [];

    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 5,
      getActiveSessionId: () => "sess-A",
      postMessage: (m) => posted.push(m),
    });

    panel.handleActivate({
      name: "Showing first 2000 files in scope — narrow your scope to see more",
      path: "__overflow__",
      kind: "file",
      searchRow: { relativePath: "__overflow__", variant: "overflow-footer" },
    });

    const openFileMsgs = posted.filter((m): m is OpenFileMessage => m.type === "openFile");
    expect(openFileMsgs).toHaveLength(0);

    panel.dispose();
  });

  it("constructs a Tree (body stamped role='tree') when workspaceRoot is provided", () => {
    const host = createHost();
    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 0,
      getActiveSessionId: () => "sess-A",
      postMessage: () => {},
    });

    // The Tree now mounts inside `.file-tree-body` (header sits above it),
    // so role="tree" lands on the body, not the panel host.
    const body = host.querySelector(".file-tree-body");
    expect(body?.getAttribute("role")).toBe("tree");
    expect(host.querySelector(".file-tree-empty")).toBeNull();
    // Header strip with the move button should be present alongside the body.
    expect(host.querySelector(".file-tree-header__btn")).not.toBeNull();

    panel.dispose();
  });
});

describe("FileTreePanel — refreshDirectoryByPath + refreshRootAndExpandedDirectories", () => {
  // Drive mountTree → initial read-directory → respond with entries → assert
  // refresh-driven re-reads. This exercises the real Tree + FileSystemDataSource
  // wiring end-to-end through the panel's public surface.

  function setupPanel(): {
    panel: FileTreePanel;
    posted: AnyMsg[];
    /** Resolve a pending request-read-directory by requestId. */
    respond: (requestId: string, entries: Array<{ name: string; path: string; kind: "file" | "directory" }>) => void;
  } {
    const host = createHost();
    const posted: AnyMsg[] = [];
    const panel = new FileTreePanel({
      host,
      workspaceRoot: "/workspace",
      rootGeneration: 1,
      getActiveSessionId: () => "sess",
      postMessage: (m) => posted.push(m),
    });
    // The data source isn't exposed by the panel API; reach in by reading
    // the private field via a casted accessor for test purposes ONLY. The
    // alternative — driving Tree's refresh through DOM events — is more
    // fragile and brittle than this small encapsulation break.
    const dataSource = (panel as unknown as { dataSource: { handleResponse(m: unknown): void } | null }).dataSource;
    if (!dataSource) {
      throw new Error("panel.dataSource was null after mount — expected mountTree to construct it");
    }
    const respond = (requestId: string, entries: Array<{ name: string; path: string; kind: "file" | "directory" }>) => {
      dataSource.handleResponse({
        type: "read-directory-response",
        requestId,
        rootGeneration: 1,
        entries,
      });
    };
    return { panel, posted, respond };
  }

  function readDirectoryPosts(posted: AnyMsg[]): Array<{ requestId: string; path: string }> {
    return posted
      .filter((m): m is RequestReadDirectoryMessage => m.type === "request-read-directory")
      .map((m) => ({ requestId: m.requestId, path: m.path }));
  }

  it("(i) refreshDirectoryByPath(workspaceRoot) refreshes the root node (re-posts read-directory for the root)", async () => {
    const { panel, posted, respond } = setupPanel();
    // Initial mount issued a read for the root; satisfy it so the root has children.
    const initial = readDirectoryPosts(posted);
    expect(initial[0].path).toBe("/workspace");
    respond(initial[0].requestId, []);
    await Promise.resolve();
    await Promise.resolve();
    const beforeCount = readDirectoryPosts(posted).length;

    panel.refreshDirectoryByPath("/workspace");
    await Promise.resolve();
    await Promise.resolve();
    const after = readDirectoryPosts(posted);
    expect(after.length).toBeGreaterThan(beforeCount);
    // The new request is for the root path.
    expect(after[after.length - 1].path).toBe("/workspace");

    panel.dispose();
  });

  it("(ii) refreshDirectoryByPath(cached dir) refreshes that cached subtree", async () => {
    const { panel, posted, respond } = setupPanel();
    const initial = readDirectoryPosts(posted);
    respond(initial[0].requestId, [{ name: "src", path: "/workspace/src", kind: "directory" }]);
    await Promise.resolve();
    await Promise.resolve();
    const beforeCount = readDirectoryPosts(posted).length;

    panel.refreshDirectoryByPath("/workspace/src");
    await Promise.resolve();
    await Promise.resolve();
    const after = readDirectoryPosts(posted);
    expect(after.length).toBeGreaterThan(beforeCount);
    expect(after[after.length - 1].path).toBe("/workspace/src");

    panel.dispose();
  });

  it("(iii) refreshDirectoryByPath(uncached path) no-ops — no new read", async () => {
    const { panel, posted, respond } = setupPanel();
    respond(readDirectoryPosts(posted)[0].requestId, []);
    await Promise.resolve();
    await Promise.resolve();
    const beforeCount = readDirectoryPosts(posted).length;

    panel.refreshDirectoryByPath("/never-cached/anywhere");
    await Promise.resolve();
    await Promise.resolve();
    expect(readDirectoryPosts(posted).length).toBe(beforeCount);

    panel.dispose();
  });

  it("(iv) refreshRootAndExpandedDirectories with root + 1 expanded refreshes both", async () => {
    const { panel, posted, respond } = setupPanel();
    const initial = readDirectoryPosts(posted);
    respond(initial[0].requestId, [{ name: "src", path: "/workspace/src", kind: "directory" }]);
    await Promise.resolve();
    await Promise.resolve();
    const internals = panel as unknown as {
      dataSource: { getCachedNode(absPath: string): FileNode | undefined } | null;
      tree: { expand(node: FileNode): void } | null;
    };
    const srcNode = internals.dataSource?.getCachedNode("/workspace/src");
    expect(srcNode).toBeDefined();
    internals.tree?.expand(srcNode as FileNode);
    await Promise.resolve();
    await Promise.resolve();
    const afterPrep = readDirectoryPosts(posted);
    const srcPrepResp = afterPrep[afterPrep.length - 1];
    respond(srcPrepResp.requestId, []);
    await Promise.resolve();
    await Promise.resolve();
    const baseline = readDirectoryPosts(posted).length;

    panel.refreshRootAndExpandedDirectories();
    await Promise.resolve();
    await Promise.resolve();
    const newPosts = readDirectoryPosts(posted).slice(baseline);
    // Root + expanded /workspace/src = 2 new reads
    const paths = newPosts.map((p) => p.path).sort();
    expect(paths).toEqual(["/workspace", "/workspace/src"]);

    panel.dispose();
  });

  it("(iv-b) refreshRootAndExpandedDirectories skips cached dirs that are not actually expanded", async () => {
    const { panel, posted, respond } = setupPanel();
    const initial = readDirectoryPosts(posted);
    respond(initial[0].requestId, [{ name: "src", path: "/workspace/src", kind: "directory" }]);
    await Promise.resolve();
    await Promise.resolve();
    (panel as unknown as { expandedPaths: Set<string> }).expandedPaths.add("/workspace/src");
    const baseline = readDirectoryPosts(posted).length;

    panel.refreshRootAndExpandedDirectories();
    await Promise.resolve();
    await Promise.resolve();
    const newPosts = readDirectoryPosts(posted).slice(baseline);
    expect(newPosts.map((p) => p.path)).toEqual(["/workspace"]);

    panel.dispose();
  });

  it("(vi) panel callbacks fan out to the search controller (onFsInvalidated + onRehydrate)", async () => {
    const { panel, respond, posted } = setupPanel();
    respond(readDirectoryPosts(posted)[0].requestId, []);
    await Promise.resolve();
    await Promise.resolve();
    // Reach in for the search controller; eagerly construct it so the
    // callbacks have somewhere to fan out (the production code lazy-creates
    // on first search-bar open). We use the private getOrCreateSearchController
    // path indirectly by writing the field.
    const onFsInvalidated = vi.fn();
    const onRehydrate = vi.fn();
    const fakeSearchController = { onFsInvalidated, onRehydrate };
    (panel as unknown as { searchController: unknown }).searchController = fakeSearchController;

    // Drive the data source's invalidate / rehydrate dispatch end-to-end —
    // these are what the panel callbacks wrap.
    panel.handleFsChangesInvalidated({
      type: "fs-changes-invalidated",
      rootGeneration: 1,
      parent: "/workspace",
    } as never);
    expect(onFsInvalidated).toHaveBeenCalledWith("/workspace");

    panel.handleFsRehydrate({ type: "fs-rehydrate", rootGeneration: 1 } as never);
    expect(onRehydrate).toHaveBeenCalledTimes(1);

    panel.dispose();
  });

  it("(vi-b) callbacks tolerate null searchController without throwing", async () => {
    const { panel, respond, posted } = setupPanel();
    respond(readDirectoryPosts(posted)[0].requestId, []);
    await Promise.resolve();
    await Promise.resolve();
    expect((panel as unknown as { searchController: unknown }).searchController).toBeNull();
    expect(() =>
      panel.handleFsChangesInvalidated({
        type: "fs-changes-invalidated",
        rootGeneration: 1,
        parent: "/workspace",
      } as never),
    ).not.toThrow();
    expect(() => panel.handleFsRehydrate({ type: "fs-rehydrate", rootGeneration: 1 } as never)).not.toThrow();
    panel.dispose();
  });

  it("(focus-steal) revealPath with source='autoReveal' MUST NOT call tree.domFocus", async () => {
    // Regression: ActiveFileRevealer posts reveal-in-file-tree with
    // source='autoReveal' whenever VS Code's active editor changes (e.g.
    // user clicked a different file in the Explorer). Previously the panel
    // unconditionally called tree.domFocus() which stole keyboard focus
    // from whatever the user was actually interacting with.
    const { panel, posted, respond } = setupPanel();
    respond(readDirectoryPosts(posted)[0].requestId, [
      { name: "a.ts", path: "/workspace/a.ts", kind: "file" },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    const tree = (panel as unknown as { tree: { domFocus(): void } | null }).tree;
    if (!tree) {
      throw new Error("Test setup: panel.tree was null after mount");
    }
    const focusSpy = vi.spyOn(tree, "domFocus");

    await panel.revealPath("/workspace/a.ts", { source: "autoReveal" });
    expect(focusSpy).not.toHaveBeenCalled();

    panel.dispose();
  });

  it("(focus-steal) revealPath with source='osc7' DOES call tree.domFocus (user-initiated reveal)", async () => {
    // User-initiated reveals (OSC 7 from a terminal `cd`, "Reveal in File
    // Tree" command) intentionally pull focus into the tree. Verifies the
    // autoReveal carve-out hasn't broken the user-driven path.
    const { panel, posted, respond } = setupPanel();
    respond(readDirectoryPosts(posted)[0].requestId, [
      { name: "a.ts", path: "/workspace/a.ts", kind: "file" },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    const tree = (panel as unknown as { tree: { domFocus(): void } | null }).tree;
    if (!tree) {
      throw new Error("Test setup: panel.tree was null after mount");
    }
    const focusSpy = vi.spyOn(tree, "domFocus");

    await panel.revealPath("/workspace/a.ts", { source: "osc7" });
    expect(focusSpy).toHaveBeenCalled();

    panel.dispose();
  });

  it("(v) refreshRootAndExpandedDirectories dedups when root is also recorded as expanded", async () => {
    const { panel, posted, respond } = setupPanel();
    const initial = readDirectoryPosts(posted);
    respond(initial[0].requestId, []);
    await Promise.resolve();
    await Promise.resolve();
    // Mount records the root in expandedPaths already; verify it's present.
    const expanded = (panel as unknown as { expandedPaths: Set<string> }).expandedPaths;
    expect(expanded.has("/workspace")).toBe(true);
    const baseline = readDirectoryPosts(posted).length;

    panel.refreshRootAndExpandedDirectories();
    await Promise.resolve();
    await Promise.resolve();
    const newPosts = readDirectoryPosts(posted).slice(baseline);
    // Only ONE read for the root, not two.
    expect(newPosts.map((p) => p.path)).toEqual(["/workspace"]);

    panel.dispose();
  });
});
