// src/providers/fileTreeHost.test.ts — Pinpoint regression tests for the
// FileTreeHost message dispatch.
//
// The host owns the central dispatch for file-tree messages; both
// TerminalViewProvider and TerminalEditorProvider forward selected message
// types to `fileTreeHost.handleMessage()`. A bug where one of those
// providers forgot to forward `request-file-tree-search` (i.e., the search
// RPC silently lost) is exactly the kind of regression these tests guard.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type {
  GitStatus,
  ReadDirectoryResponseMessage,
  RequestFileTreeSearchMessage,
  RequestReadDirectoryMessage,
  WebViewToExtensionMessage,
} from "../types/messages";
import { FileTreeHost } from "./fileTreeHost";
import type { WatcherPool } from "./fsWatcherPool";
import type { GitDecorationProvider } from "./gitDecorationProvider";

describe("FileTreeHost.handleMessage", () => {
  it("handles `request-file-tree-search` and posts a response back", async () => {
    const host = new FileTreeHost();
    const posted: unknown[] = [];

    const msg: RequestFileTreeSearchMessage = {
      type: "request-file-tree-search",
      requestId: "rq",
      rootGeneration: 0,
      scopePath: "/some/path/not/in/workspace",
      maxResults: 100,
    };

    const handled = host.handleMessage(msg, (m) => posted.push(m));
    expect(handled).toBe(true);

    // Allow the inner promise to resolve. Without a workspace folder set the
    // host falls into the `OUT_OF_WORKSPACE` branch and posts an error —
    // the exact response content isn't the point. We're asserting that the
    // message TYPE was claimed by the host (the dispatch wiring is the
    // regression target).
    await new Promise((r) => setTimeout(r, 0));
    expect(posted.length).toBe(1);
    expect((posted[0] as { type?: string }).type).toBe("file-tree-search-response");
  });

  it("returns false for messages it doesn't own (e.g. `input`)", () => {
    const host = new FileTreeHost();
    const noopPost = vi.fn();
    const unrelated = { type: "input", tabId: "t", data: "x" } as WebViewToExtensionMessage;
    expect(host.handleMessage(unrelated, noopPost)).toBe(false);
    expect(noopPost).not.toHaveBeenCalled();
  });

  it("handles `request-open-folder` by showing the native folder picker", async () => {
    const host = new FileTreeHost();
    const postSpy = vi.fn();
    const dialogSpy = vi.spyOn(vscode.window, "showOpenDialog").mockResolvedValue(undefined);

    try {
      const handled = host.handleMessage({ type: "request-open-folder" }, postSpy);
      expect(handled).toBe(true);
      // The dialog is async; let it resolve.
      await new Promise((r) => setTimeout(r, 0));
      expect(dialogSpy).toHaveBeenCalledTimes(1);
      expect(dialogSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
        }),
      );
      // User cancelled (resolved undefined) → no reveal posted.
      expect(postSpy).not.toHaveBeenCalled();
    } finally {
      dialogSpy.mockRestore();
    }
  });

  it("posts `reveal-in-file-tree` with the picked path via attachPost after `request-open-folder` resolves", async () => {
    const host = new FileTreeHost();
    const attachPostSpy = vi.fn();
    // attach() wires the host's stable channel; pass a stub isReady=true so
    // the post is not gated out.
    host.attach({ isReady: () => true, post: attachPostSpy });

    const dialogSpy = vi
      .spyOn(vscode.window, "showOpenDialog")
      .mockResolvedValue([{ fsPath: "/picked/folder" } as vscode.Uri]);

    try {
      const handled = host.handleMessage({ type: "request-open-folder" }, vi.fn());
      expect(handled).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(attachPostSpy).toHaveBeenCalledTimes(1);
      expect(attachPostSpy).toHaveBeenCalledWith({
        type: "reveal-in-file-tree",
        absPath: "/picked/folder",
        source: "openFolder",
      });
    } finally {
      dialogSpy.mockRestore();
    }
  });

  it("warns when a picked folder cannot be posted because the webview is no longer ready", async () => {
    const host = new FileTreeHost();
    const attachPostSpy = vi.fn();
    host.attach({ isReady: () => false, post: attachPostSpy });
    const dialogSpy = vi
      .spyOn(vscode.window, "showOpenDialog")
      .mockResolvedValue([{ fsPath: "/picked/folder" } as vscode.Uri]);
    const warningSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);

    try {
      const handled = host.handleMessage({ type: "request-open-folder" }, vi.fn());
      expect(handled).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(attachPostSpy).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(
        "AnyWhere Terminal file tree is no longer available. Reopen it and try again.",
      );
    } finally {
      dialogSpy.mockRestore();
      warningSpy.mockRestore();
    }
  });

  it("surfaces an error message when the folder picker rejects", async () => {
    const host = new FileTreeHost();
    const dialogSpy = vi.spyOn(vscode.window, "showOpenDialog").mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    try {
      const handled = host.handleMessage({ type: "request-open-folder" }, vi.fn());
      expect(handled).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(errorSpy).toHaveBeenCalledWith("AnyWhere Terminal could not open the folder picker.");
    } finally {
      dialogSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("FileTreeHost — git decoration stamping on read-directory", () => {
  // Stand up a real on-disk temp directory so the RPC handler can enumerate
  // it through the production code path (no extra mocking of `fs`).
  let tmp: string;
  let fileA: string;
  let fileB: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atest-gitstamp-"));
    fileA = path.join(tmp, "a.ts");
    fileB = path.join(tmp, "b.ts");
    fs.writeFileSync(fileA, "");
    fs.writeFileSync(fileB, "");
    // The vscode mock doesn't ship a `workspace.fs.readDirectory`; install one
    // that delegates to node:fs so the production RPC handler enumerates the
    // real tmp dir. FileType bit values: File=1, Directory=2 (matches `vscode.FileType`).
    (vscode.workspace.fs as unknown as { readDirectory: unknown }).readDirectory = async (uri: { fsPath: string }) => {
      const entries = fs.readdirSync(uri.fsPath, { withFileTypes: true });
      return entries.map((e): [string, number] => [e.name, e.isDirectory() ? 2 : 1]);
    };
  });

  afterEach(() => {
    delete (vscode.workspace.fs as unknown as { readDirectory?: unknown }).readDirectory;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function makeRpc(): RequestReadDirectoryMessage {
    return {
      type: "request-read-directory",
      requestId: "rq",
      rootGeneration: 0,
      path: tmp,
    };
  }

  function fakeProvider(table: ReadonlyMap<string, GitStatus>, revision = 7): GitDecorationProvider {
    return {
      getStatus: (p: string) => {
        const status = table.get(p);
        return { status, revision };
      },
      currentRevision: () => revision,
      getDescendantBuckets: () => undefined,
      onDidChange: () => ({ dispose: () => {} }),
      reset: () => {},
      dispose: () => {},
    };
  }

  async function runRpc(provider: GitDecorationProvider | null): Promise<ReadDirectoryResponseMessage> {
    const host = new FileTreeHost(provider);
    const posted: ReadDirectoryResponseMessage[] = [];
    host.handleMessage(makeRpc(), (m) => posted.push(m as ReadDirectoryResponseMessage));
    // The handler is async; allow time for fs.readDirectory + git check-ignore
    // (which spawns a process — on a non-git directory it exits with code 128
    // typically within a few ms, but give it generous headroom on slow CI).
    for (let i = 0; i < 50 && posted.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(posted.length).toBe(1);
    return posted[0];
  }

  it("stamps every entry with revision and copies higher-severity status", async () => {
    const provider = fakeProvider(new Map([[fileA, "modified"]]), 7);
    const resp = await runRpc(provider);
    expect(resp.entries).toBeDefined();
    const a = resp.entries!.find((e) => e.path === fileA);
    const b = resp.entries!.find((e) => e.path === fileB);
    expect(a?.gitStatus).toBe<GitStatus>("modified");
    expect(a?.gitRevision).toBe(7);
    expect(b?.gitStatus).toBeUndefined();
    expect(b?.gitRevision).toBe(7);
  });

  it("omits gitStatus/gitRevision when no provider is wired", async () => {
    const resp = await runRpc(null);
    expect(resp.entries).toBeDefined();
    for (const e of resp.entries!) {
      expect(e.gitStatus).toBeUndefined();
      expect(e.gitRevision).toBeUndefined();
    }
  });

  it("revision increases across two reads with an intervening provider state change", async () => {
    let currentRev = 3;
    let currentTable = new Map<string, GitStatus>([[fileA, "modified"]]);
    const provider: GitDecorationProvider = {
      getStatus: (p) => ({ status: currentTable.get(p), revision: currentRev }),
      currentRevision: () => currentRev,
      getDescendantBuckets: () => undefined,
      onDidChange: () => ({ dispose: () => {} }),
      reset: () => {},
      dispose: () => {},
    };
    const first = await runRpc(provider);
    expect(first.entries!.find((e) => e.path === fileA)?.gitRevision).toBe(3);
    currentRev = 9;
    currentTable = new Map([[fileA, "added"]]);
    const second = await runRpc(provider);
    expect(second.entries!.find((e) => e.path === fileA)?.gitRevision).toBe(9);
    expect(second.entries!.find((e) => e.path === fileA)?.gitStatus).toBe<GitStatus>("added");
  });
});

describe("FileTreeHost.attach — git delta forwarding", () => {
  it("forwards provider deltas as git-status-changed messages with current rootGeneration", () => {
    let onDelta:
      | ((d: { revision: number; changes: ReadonlyArray<{ path: string; status: GitStatus | null }> }) => void)
      | null = null;
    const provider: GitDecorationProvider = {
      getStatus: () => ({ status: undefined, revision: 0 }),
      currentRevision: () => 0,
      getDescendantBuckets: () => undefined,
      onDidChange: (listener) => {
        onDelta = listener;
        return { dispose: () => {} };
      },
      reset: () => {},
      dispose: () => {},
    };
    const host = new FileTreeHost(provider);
    const posted: Array<{ type: string; rootGeneration?: number; revision?: number }> = [];
    const sub = host.attach({
      isReady: () => true,
      post: (m) => posted.push(m as { type: string; rootGeneration?: number; revision?: number }),
    });
    expect(onDelta).not.toBeNull();

    // Bump generation to 1 so we know the host stamps the current value, not 0.
    host.rootGeneration = 1;
    onDelta!({ revision: 42, changes: [{ path: "/x", status: "modified" }] });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("git-status-changed");
    expect(posted[0].rootGeneration).toBe(1);
    expect(posted[0].revision).toBe(42);

    sub.dispose();
  });

  it("does NOT post deltas when the webview is not ready yet", () => {
    let onDelta:
      | ((d: { revision: number; changes: ReadonlyArray<{ path: string; status: GitStatus | null }> }) => void)
      | null = null;
    const provider: GitDecorationProvider = {
      getStatus: () => ({ status: undefined, revision: 0 }),
      currentRevision: () => 0,
      getDescendantBuckets: () => undefined,
      onDidChange: (listener) => {
        onDelta = listener;
        return { dispose: () => {} };
      },
      reset: () => {},
      dispose: () => {},
    };
    const host = new FileTreeHost(provider);
    const posted: unknown[] = [];
    let ready = false;
    const sub = host.attach({
      isReady: () => ready,
      post: (m) => posted.push(m),
    });
    onDelta!({ revision: 1, changes: [{ path: "/x", status: "modified" }] });
    expect(posted).toHaveLength(0);

    ready = true;
    onDelta!({ revision: 2, changes: [{ path: "/x", status: "added" }] });
    expect(posted).toHaveLength(1);

    sub.dispose();
  });

  it("forwards pool's onDidRequestRehydrate as fs-rehydrate with current rootGeneration (only when ready)", () => {
    let onRehydrate: (() => void) | null = null;
    const pool: WatcherPool = {
      subscribe: () => ({ dispose: () => {} }),
      onDidRequestRehydrate: (listener) => {
        onRehydrate = listener;
        return { dispose: () => {} };
      },
      dispose: () => {},
    };
    const host = new FileTreeHost(null, pool);
    const posted: Array<{ type: string; rootGeneration?: number }> = [];
    let ready = false;
    const sub = host.attach({
      isReady: () => ready,
      post: (m) => posted.push(m as { type: string; rootGeneration?: number }),
    });
    expect(onRehydrate).not.toBeNull();

    // Not ready yet — drop.
    onRehydrate!();
    expect(posted).toHaveLength(0);

    ready = true;
    host.rootGeneration = 5;
    onRehydrate!();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("fs-rehydrate");
    expect(posted[0].rootGeneration).toBe(5);

    sub.dispose();
  });

  it("bumps rootGeneration on workspace folder change WITHOUT calling provider.reset() (O-W3)", () => {
    // The provider now owns its own workspace-folder reset (subscribes once
    // inside `createGitDecorationProvider`). FileTreeHost must NOT call
    // `provider.reset()` — otherwise the reset fan-out scales with the host
    // count again.
    const resetSpy = vi.fn();
    const provider: GitDecorationProvider = {
      getStatus: () => ({ status: undefined, revision: 0 }),
      currentRevision: () => 0,
      getDescendantBuckets: () => undefined,
      onDidChange: () => ({ dispose: () => {} }),
      reset: resetSpy,
      dispose: () => {},
    };

    let folderHandler: (() => void) | null = null;
    const original = vscode.workspace.onDidChangeWorkspaceFolders;
    (vscode.workspace as { onDidChangeWorkspaceFolders: unknown }).onDidChangeWorkspaceFolders = ((h: () => void) => {
      folderHandler = h;
      return { dispose: () => {} };
    }) as unknown;

    try {
      const host = new FileTreeHost(provider);
      const sub = host.attach({ isReady: () => true, post: () => {} });
      const beforeGen = host.rootGeneration;
      folderHandler!();
      expect(resetSpy).not.toHaveBeenCalled();
      expect(host.rootGeneration).toBe(beforeGen + 1);
      sub.dispose();
    } finally {
      (vscode.workspace as { onDidChangeWorkspaceFolders: unknown }).onDidChangeWorkspaceFolders = original;
    }
  });
});

describe("FileTreeHost — FS subscribe/unsubscribe/rehydrate dispatch", () => {
  function makeFakePool(): {
    pool: WatcherPool;
    subscribeCalls: Array<{ path: string; cb: () => void; dispose: ReturnType<typeof vi.fn> }>;
    fireRehydrate: () => void;
  } {
    const subscribeCalls: Array<{ path: string; cb: () => void; dispose: ReturnType<typeof vi.fn> }> = [];
    let rehydrateListener: (() => void) | null = null;
    const pool: WatcherPool = {
      subscribe: (path: string, cb: () => void) => {
        const dispose = vi.fn();
        subscribeCalls.push({ path, cb, dispose });
        return { dispose };
      },
      onDidRequestRehydrate: (l) => {
        rehydrateListener = l;
        return { dispose: () => {} };
      },
      dispose: () => {},
    };
    return {
      pool,
      subscribeCalls,
      fireRehydrate: () => rehydrateListener?.(),
    };
  }

  function attachHost(host: FileTreeHost): {
    posted: Array<{ type: string; rootGeneration?: number; parent?: string }>;
    sub: vscode.Disposable;
  } {
    const posted: Array<{ type: string; rootGeneration?: number; parent?: string }> = [];
    const sub = host.attach({
      isReady: () => true,
      post: (m) => posted.push(m as { type: string; rootGeneration?: number; parent?: string }),
    });
    return { posted, sub };
  }

  it("(a) request-subscribe-fs-changes calls pool.subscribe once; firing the callback posts fs-changes-invalidated", () => {
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { posted, sub } = attachHost(host);

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/foo" }, () => {});
    expect(subscribeCalls.length).toBe(1);
    expect(subscribeCalls[0].path).toBe("/foo");

    // Invoke the captured callback — the host should post the invalidate.
    subscribeCalls[0].cb();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("fs-changes-invalidated");
    expect(posted[0].parent).toBe("/foo");
    expect(posted[0].rootGeneration).toBe(0);

    sub.dispose();
  });

  it("(b) idempotent — second subscribe to the same path is a no-op", () => {
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { sub } = attachHost(host);

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/foo" }, () => {});
    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/foo" }, () => {});
    expect(subscribeCalls.length).toBe(1);

    sub.dispose();
  });

  it("(c) stale rootGeneration: subscribe dropped, no pool.subscribe call, no post", () => {
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { posted, sub } = attachHost(host);
    host.rootGeneration = 7;

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 6, path: "/foo" }, () => {});
    expect(subscribeCalls.length).toBe(0);
    expect(posted).toHaveLength(0);

    sub.dispose();
  });

  it("(d) request-unsubscribe-fs-changes disposes each matching map entry; ignores unknown", () => {
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { sub } = attachHost(host);

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/a" }, () => {});
    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/b" }, () => {});
    expect(subscribeCalls.length).toBe(2);

    host.handleMessage(
      { type: "request-unsubscribe-fs-changes", rootGeneration: 0, paths: ["/a", "/missing"] },
      () => {},
    );
    expect(subscribeCalls[0].dispose).toHaveBeenCalledTimes(1);
    expect(subscribeCalls[1].dispose).not.toHaveBeenCalled();

    // Re-subscribe after unsubscribe creates a NEW pool subscription
    // (idempotency check applies only to active entries).
    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/a" }, () => {});
    expect(subscribeCalls.length).toBe(3);

    sub.dispose();
  });

  it("(d2) request-unsubscribe-fs-changes bypasses rootGeneration gate (review W1)", () => {
    // After a rapid root rotation A→B→C, the webview posts the bulk
    // unsubscribe for B under generation B, but the host is already at
    // generation C. The unsubscribe MUST still dispose the matching map
    // entry — otherwise the host leaks the subscription forever.
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { sub } = attachHost(host);

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/a" }, () => {});
    expect(subscribeCalls.length).toBe(1);

    // Rotate the host's generation past the message's tag.
    host.rootGeneration = 5;
    host.handleMessage({ type: "request-unsubscribe-fs-changes", rootGeneration: 2, paths: ["/a"] }, () => {});
    expect(subscribeCalls[0].dispose).toHaveBeenCalledTimes(1);

    sub.dispose();
  });

  it("(e) callback closes over LIVE rootGeneration — bump between subscribe and event fire is reflected", () => {
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { posted, sub } = attachHost(host);

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/foo" }, () => {});
    host.rootGeneration = 9;
    subscribeCalls[0].cb();

    expect(posted).toHaveLength(1);
    expect(posted[0].rootGeneration).toBe(9);

    sub.dispose();
  });

  it("(f) rehydrate posts fs-rehydrate only when isReady() is true", () => {
    const { pool, fireRehydrate } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const posted: Array<{ type: string }> = [];
    let ready = false;
    const sub = host.attach({
      isReady: () => ready,
      post: (m) => posted.push(m as { type: string }),
    });

    fireRehydrate();
    expect(posted).toHaveLength(0);

    ready = true;
    fireRehydrate();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("fs-rehydrate");

    sub.dispose();
  });

  it("(g) attach() cleanup Disposable disposes every subscription + the rehydrate sub", () => {
    const { pool, subscribeCalls } = makeFakePool();
    const host = new FileTreeHost(null, pool);
    const { sub } = attachHost(host);

    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/a" }, () => {});
    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/b" }, () => {});

    sub.dispose();
    expect(subscribeCalls[0].dispose).toHaveBeenCalledTimes(1);
    expect(subscribeCalls[1].dispose).toHaveBeenCalledTimes(1);

    // After cleanup, the per-host map is empty — re-attach can re-subscribe.
    const { sub: sub2 } = attachHost(host);
    host.handleMessage({ type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/a" }, () => {});
    expect(subscribeCalls.length).toBe(3);
    sub2.dispose();
  });

  it("(h) when watcherPool is null, subscribe/unsubscribe messages are silently ignored", () => {
    const host = new FileTreeHost(null, null);
    const posted: unknown[] = [];
    const sub = host.attach({ isReady: () => true, post: (m) => posted.push(m) });

    const subResult = host.handleMessage(
      { type: "request-subscribe-fs-changes", rootGeneration: 0, path: "/foo" },
      () => {},
    );
    const unsubResult = host.handleMessage(
      { type: "request-unsubscribe-fs-changes", rootGeneration: 0, paths: ["/foo"] },
      () => {},
    );
    expect(subResult).toBe(true);
    expect(unsubResult).toBe(true);
    expect(posted).toHaveLength(0);

    sub.dispose();
  });
});
