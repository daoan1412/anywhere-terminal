// src/webview/fileTree/search/__tests__/FileTreeSearchController.test.ts
//
// Covers:
//   (a) typing 3 chars triggers 1 RPC (debounce coalesces)
//   (b) typing N chars after cache populated triggers 0 RPCs
//   (c) mode toggle triggers 0 RPCs
//   (d) WorkspaceRootChanged invalidates cache + emits cancel
//   (e) exit drops pending response + emits cancel
//   (f) cache TTL expiry re-fires
//   (g) late stale-requestId response discarded
//   (h) overflow footer / error marker

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CancelFileTreeSearchMessage,
  FileTreeSearchResponseMessage,
  RequestFileTreeSearchMessage,
} from "../../../../types/messages";
import type { FileNode } from "../../IFileSystemProvider";
import {
  CACHE_TTL_MS,
  ENUMERATION_DEBOUNCE_MS,
  ERROR_SENTINEL_PATH,
  FileTreeSearchController,
  OVERFLOW_SENTINEL_PATH,
} from "../FileTreeSearchController";

type AnyPost = RequestFileTreeSearchMessage | CancelFileTreeSearchMessage;

function makeTreeSpy() {
  return {
    setFlatItems: vi.fn<(items: FileNode[] | null, m?: ReadonlyMap<FileNode, unknown>) => void>(),
  };
}

describe("FileTreeSearchController", () => {
  const ROOT_GEN = 0;
  let posts: AnyPost[];

  beforeEach(() => {
    posts = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeController(opts?: { rootGen?: () => number }) {
    const tree = makeTreeSpy();
    let id = 0;
    const controller = new FileTreeSearchController({
      tree,
      post: (m) => posts.push(m),
      getRootGeneration: opts?.rootGen ?? (() => ROOT_GEN),
      nextRequestId: () => `req-${++id}`,
    });
    return { controller, tree };
  }

  function searchPosts(): RequestFileTreeSearchMessage[] {
    return posts.filter((m): m is RequestFileTreeSearchMessage => m.type === "request-file-tree-search");
  }

  function cancelPosts(): CancelFileTreeSearchMessage[] {
    return posts.filter((m): m is CancelFileTreeSearchMessage => m.type === "cancel-file-tree-search");
  }

  it("(a) typing during the debounce window collapses into ONE RPC", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    controller.setQuery("f");
    vi.advanceTimersByTime(50);
    controller.setQuery("fp");
    vi.advanceTimersByTime(50);
    controller.setQuery("fpt");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    const sp = searchPosts();
    expect(sp).toHaveLength(1);
    expect(sp[0].scopePath).toBe("/repo/src");
    expect(sp[0].rootGeneration).toBe(ROOT_GEN);
  });

  it("(b) after cache populated, further keystrokes don't trigger new RPCs", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts()).toHaveLength(1);
    const requestId = searchPosts()[0].requestId;
    controller.onResponse({
      type: "file-tree-search-response",
      requestId,
      rootGeneration: ROOT_GEN,
      results: [
        { absolutePath: "/repo/src/FileTreePanel.ts", relativePath: "FileTreePanel.ts" },
        { absolutePath: "/repo/src/main.ts", relativePath: "main.ts" },
      ],
      truncated: false,
    });

    controller.setQuery("fp");
    controller.setQuery("ftp");
    controller.setQuery("");
    vi.advanceTimersByTime(1_000);
    expect(searchPosts()).toHaveLength(1);
  });

  it("(c) mode toggle does NOT trigger an RPC", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: "/repo/src/a.ts", relativePath: "a.ts" }],
      truncated: false,
    });
    controller.setMode("highlight");
    controller.setMode("filter");
    vi.advanceTimersByTime(1_000);
    expect(searchPosts()).toHaveLength(1);
  });

  it("(d) WorkspaceRootChanged invalidates the cache and emits a cancel signal when something was in flight", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    // RPC fired but response not yet processed — pendingRequestId is set.
    expect(searchPosts()).toHaveLength(1);

    controller.onWorkspaceRootChanged();
    expect(cancelPosts()).toHaveLength(1);

    // Next keystroke after invalidation triggers a fresh RPC.
    controller.setQuery("y");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts()).toHaveLength(2);
  });

  it("(d.2) WorkspaceRootChanged with nothing in flight does NOT emit a cancel signal", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [],
      truncated: false,
    });
    controller.onWorkspaceRootChanged();
    expect(cancelPosts()).toHaveLength(0);
  });

  it("(e) exit() drops pending response and emits a cancel signal", () => {
    const { controller, tree } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts()).toHaveLength(1);
    const reqId = searchPosts()[0].requestId;

    controller.exit();
    expect(cancelPosts()).toHaveLength(1);

    const consumed = controller.onResponse({
      type: "file-tree-search-response",
      requestId: reqId,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: "/repo/src/a.ts", relativePath: "a.ts" }],
      truncated: false,
    });
    expect(consumed).toBe(false);
    expect(tree.setFlatItems).toHaveBeenLastCalledWith(null);
  });

  it("(e.2) exit() with nothing in flight does NOT emit a cancel signal", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [],
      truncated: false,
    });
    controller.exit();
    expect(cancelPosts()).toHaveLength(0);
  });

  it("(f) cache TTL expiry triggers a new RPC", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: "/repo/src/a.ts", relativePath: "a.ts" }],
      truncated: false,
    });

    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    controller.setQuery("z");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts()).toHaveLength(2);
  });

  it("re-entering the same fresh scope reuses the cached enumeration", () => {
    const { controller } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: "/repo/src/a.ts", relativePath: "a.ts" }],
      truncated: false,
    });
    expect(searchPosts()).toHaveLength(1);

    controller.exit();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(1_000);
    expect(searchPosts()).toHaveLength(1);
  });

  it("(g) late stale-requestId response is discarded", () => {
    const { controller, tree } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    const reqId1 = searchPosts()[0].requestId;

    controller.onResponse({
      type: "file-tree-search-response",
      requestId: reqId1,
      rootGeneration: ROOT_GEN,
      results: [],
      truncated: false,
    });
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    controller.setQuery("x");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts().length).toBeGreaterThanOrEqual(2);

    const stale: FileTreeSearchResponseMessage = {
      type: "file-tree-search-response",
      requestId: reqId1,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: "/repo/src/old.ts", relativePath: "old.ts" }],
      truncated: false,
    };
    expect(controller.onResponse(stale)).toBe(false);
    const sawOldRow = tree.setFlatItems.mock.calls.some((call) => {
      const items = (call[0] ?? []) as FileNode[];
      return items.some((n) => n.name === "old.ts");
    });
    expect(sawOldRow).toBe(false);
  });

  it("renders overflow footer when truncated", () => {
    const { controller, tree } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: "/repo/src/a.ts", relativePath: "a.ts" }],
      truncated: true,
    });
    const lastCall = tree.setFlatItems.mock.calls.at(-1);
    const items = (lastCall?.[0] ?? []) as FileNode[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.at(-1)?.path).toBe(OVERFLOW_SENTINEL_PATH);
  });

  it("renders error marker when response carries error", () => {
    const { controller, tree } = makeController();
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      error: { code: "INTERNAL", message: "boom" },
    });
    const lastCall = tree.setFlatItems.mock.calls.at(-1);
    const items = (lastCall?.[0] ?? []) as FileNode[];
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe(ERROR_SENTINEL_PATH);
    expect(items[0].searchRow?.errorMessage).toBe("boom");
  });
});

describe("FileTreeSearchController.onFsInvalidated + onRehydrate", () => {
  const ROOT_GEN = 0;
  let posts: AnyPost[];

  beforeEach(() => {
    posts = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeController() {
    const tree = makeTreeSpy();
    let id = 0;
    const controller = new FileTreeSearchController({
      tree,
      post: (m) => posts.push(m),
      getRootGeneration: () => ROOT_GEN,
      nextRequestId: () => `req-${++id}`,
    });
    return { controller, tree };
  }

  function searchPosts(): RequestFileTreeSearchMessage[] {
    return posts.filter((m): m is RequestFileTreeSearchMessage => m.type === "request-file-tree-search");
  }

  function populateCache(controller: FileTreeSearchController, scope: string): void {
    controller.enter(scope);
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    controller.onResponse({
      type: "file-tree-search-response",
      requestId: searchPosts()[0].requestId,
      rootGeneration: ROOT_GEN,
      results: [{ absolutePath: `${scope}/x.ts`, relativePath: "x.ts" }],
      truncated: false,
    });
  }

  it("(a) onFsInvalidated(scope) with fresh cache → cache cleared + enumeration scheduled while active", () => {
    const { controller } = makeController();
    populateCache(controller, "/repo/src");
    const beforeCount = searchPosts().length;
    controller.onFsInvalidated("/repo/src");
    // Cache cleared but enumeration is debounced — no post yet.
    expect(searchPosts().length).toBe(beforeCount);
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    const after = searchPosts();
    expect(after.length).toBe(beforeCount + 1);
    expect(after[after.length - 1].scopePath).toBe("/repo/src");
  });

  it("(b) onFsInvalidated(child path under scope) → cache cleared + enumeration scheduled", () => {
    const { controller } = makeController();
    populateCache(controller, "/repo/src");
    const beforeCount = searchPosts().length;
    controller.onFsInvalidated("/repo/src/sub/file.md");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts().length).toBe(beforeCount + 1);
  });

  it("(c) onFsInvalidated(unrelated path) → cache untouched, no enumeration scheduled, no new post", () => {
    const { controller } = makeController();
    populateCache(controller, "/repo/src");
    const beforeCount = searchPosts().length;
    controller.onFsInvalidated("/unrelated/elsewhere/file.md");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS * 2);
    expect(searchPosts().length).toBe(beforeCount);
  });

  it("(d) onFsInvalidated(scope) while search inactive → cache cleared but NO enumeration scheduled", () => {
    const { controller } = makeController();
    populateCache(controller, "/repo/src");
    controller.exit(); // search bar closed; cache retained per exit() contract
    const beforeCount = searchPosts().length;
    controller.onFsInvalidated("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS * 2);
    expect(searchPosts().length).toBe(beforeCount);
    // Re-entry re-enumerates via cacheIsFresh()=false gate
    controller.enter("/repo/src");
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts().length).toBe(beforeCount + 1);
  });

  it("(e) onRehydrate clears cache + schedules enumeration when active; silent no-op when no cache", () => {
    const { controller } = makeController();
    // No cache → no-op
    controller.onRehydrate();
    expect(searchPosts()).toHaveLength(0);
    populateCache(controller, "/repo/src");
    const beforeCount = searchPosts().length;
    controller.onRehydrate();
    vi.advanceTimersByTime(ENUMERATION_DEBOUNCE_MS);
    expect(searchPosts().length).toBe(beforeCount + 1);
  });
});
