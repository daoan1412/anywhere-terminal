// src/webview/fileTree/FileSystemDataSource.ts — Webview-side file-system
// provider + tree data source.
//
// Couples `IFileSystemProvider` (the abstract FS surface) with
// `ITreeDataSource<FileNode>` (what `Tree<FileNode>` consumes) so a single
// instance can power both a renderer that needs raw `FileEntry` rows and the
// tree widget that needs `FileNode` graph traversal.
//
// Every `readDirectory` posts a `RequestReadDirectoryMessage` to the
// extension host and parks the awaiter in `pending`. Responses are reunited
// via `handleResponse` keyed on `requestId`. Stale responses — those whose
// `rootGeneration` no longer matches the source's current generation — are
// logged and dropped (design D10).
//
// Lifecycle:
//   - `dispose()` rejects all in-flight requests with `CancellationError`,
//     clears the pending map, and flips the `disposed` flag so subsequent
//     `readDirectory()` calls reject immediately. Idempotent.
//   - `handleRootChanged(...)` is INTENTIONALLY not implemented here; task 3_5
//     will add it.
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D4, D10
//      asimov/changes/port-vscode-async-data-tree/specs/file-tree-rpc/spec.md
//        #requirement-file-system-provider-interface-webview-side
//        #requirement-rpc-correlation

import type { FileEntry, ReadDirectoryResponseMessage, RequestReadDirectoryMessage } from "../../types/messages";
import type { FileNode, FileStat, IFileSystemProvider } from "./IFileSystemProvider";
import type { ITreeDataSource } from "./ITreeDataSource";

/**
 * Local cancellation marker. Kept tiny so we don't drag in the vendored
 * `vs/base/common/errors` module for a single sentinel. The `name` field is
 * what call-sites usually pattern-match on.
 */
class CancellationError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

interface PendingRequest {
  resolve: (entries: FileEntry[]) => void;
  reject: (err: Error) => void;
}

/**
 * Construction-time bootstrap. Mirrors the fields carried on the initial
 * `InitMessage` so the data source can post correctly-generationed requests
 * before the first `workspace-root-changed` event ever fires.
 */
export interface FileSystemDataSourceInit {
  rootGeneration: number;
  workspaceRoot: string | null;
}

export class FileSystemDataSource implements IFileSystemProvider, ITreeDataSource<FileNode> {
  private readonly pending = new Map<string, PendingRequest>();
  private currentRootGeneration: number;
  private workspaceRoot: string | null;
  private requestCounter = 0;
  private disposed = false;
  /**
   * Per-source unique prefix. Prepended to every `requestId` so a stale
   * in-flight response from a DISPOSED source can't collide with the new
   * source's pending map after `FileTreePanel.setRoot` rebuilds everything
   * within the same millisecond (counter resets to 0, `Date.now()` may not
   * advance, generation may be unchanged — without a prefix the requestId
   * strings repeat and the wrong promise resolves with the old payload).
   *
   * `crypto.randomUUID()` is available in all VS Code webview contexts
   * (Electron's Chromium ships it since v15+); the webview surface targets
   * VS Code 1.74+, so the API is guaranteed.
   */
  private readonly sourceId: string;
  /**
   * Path-keyed `FileNode` cache. Returns the SAME `FileNode` object for
   * the same absolute path across multiple `getChildren()` calls — required
   * by `Tree<T>`'s identity-stable cache contract (Tree.ts header docs).
   *
   * Without this cache, every `getChildren()` allocated a fresh `FileNode`
   * (entries.map((e) => ({...}))), so `Tree.nodes.has(child)` always missed
   * on re-expansion. The Tree then added a new entry per cycle and the
   * previous-cycle entry leaked — B1 from review round-1.
   *
   * Bounded by total unique paths visited per source instance. A new
   * `FileSystemDataSource` is constructed by `FileTreePanel.setRoot`
   * (re-root) and `handleRootChanged` (workspace folder change), so the
   * cache lifetime is bounded by those events as well.
   */
  private readonly nodeCache = new Map<string, FileNode>();

  constructor(
    init: FileSystemDataSourceInit,
    private readonly postMessage: (m: RequestReadDirectoryMessage) => void,
  ) {
    this.currentRootGeneration = init.rootGeneration;
    this.workspaceRoot = init.workspaceRoot;
    // crypto.randomUUID returns a 36-char string with enough entropy that
    // collision across two coexisting sources is impossible in practice.
    // The `typeof crypto?.randomUUID === "function"` form covers older
    // JSDOM versions where `crypto` exists without `randomUUID`.
    this.sourceId =
      typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // ─── ITreeDataSource<FileNode> ────────────────────────────────────

  hasChildren(element: FileNode | null): boolean {
    // The implicit root (`null`) always exposes the workspace as a child;
    // every directory might have children — we won't know for sure until we
    // call `readDirectory`, but this method is sync-only and called per row,
    // so we err on the side of showing the chevron.
    return element === null || element.kind === "directory";
  }

  async getChildren(element: FileNode | null): Promise<FileNode[]> {
    const path = element?.path ?? this.workspaceRoot ?? "";
    if (!path) {
      return [];
    }
    const entries = await this.readDirectory(path);
    // Identity-stable: same path → same FileNode object across calls. Tree's
    // identity-keyed cache (Tree.nodes Map) requires this contract; without
    // it, re-expansion would always cache-miss and leak entries (B1).
    // We mutate the cached node's fields when metadata changes (kind,
    // ignored) so consumers observe the latest backend state.
    return entries.map((e) => {
      const cached = this.nodeCache.get(e.path);
      if (cached) {
        // Refresh mutable fields. Identity preserved.
        cached.name = e.name;
        cached.kind = e.kind;
        cached.ignored = e.ignored;
        return cached;
      }
      const node: FileNode = {
        name: e.name,
        path: e.path,
        kind: e.kind,
        // Propagate git-ignored flag from the RPC entry. Undefined when the
        // extension host couldn't run `git check-ignore` (no repo, no git, etc.).
        ignored: e.ignored,
      };
      this.nodeCache.set(e.path, node);
      return node;
    });
  }

  // ─── IFileSystemProvider ──────────────────────────────────────────

  readDirectory(path: string): Promise<FileEntry[]> {
    if (this.disposed) {
      return Promise.reject(new CancellationError("FileSystemDataSource disposed"));
    }
    const requestId = `${this.sourceId}-${this.requestCounter++}`;
    return new Promise<FileEntry[]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.postMessage({
        type: "request-read-directory",
        requestId,
        rootGeneration: this.currentRootGeneration,
        path,
      });
    });
  }

  async stat(path: string): Promise<FileStat> {
    // Reserved for a future change — make it loud if a renderer reaches here.
    throw new Error(`FileSystemDataSource.stat not implemented for ${path}`);
  }

  // ─── Response intake ──────────────────────────────────────────────

  /**
   * Called by the webview `MessageRouter` when a
   * `read-directory-response` message arrives. Matches by `requestId`,
   * tolerating both unknown ids (logged + dropped) and stale generation
   * (logged + dropped, design D10).
   */
  handleResponse(msg: ReadDirectoryResponseMessage): void {
    if (msg.rootGeneration !== this.currentRootGeneration) {
      // Stale workspace generation — log + drop. The pending entry, if any,
      // remains parked; task 3_5 (handleRootChanged) is responsible for
      // bulk-cancelling all in-flight requests when the root rotates.
      console.warn("[FileSystemDataSource] dropping response — generation mismatch", {
        requestId: msg.requestId,
        msgGeneration: msg.rootGeneration,
        expected: this.currentRootGeneration,
      });
      return;
    }
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      console.warn("[FileSystemDataSource] orphan response — unknown requestId", msg.requestId);
      return;
    }
    this.pending.delete(msg.requestId);
    if (msg.error) {
      pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      return;
    }
    pending.resolve(msg.entries ?? []);
  }

  // ─── Workspace-root change (design D10) ──────────────────────────

  /**
   * Adopt a new workspace root and generation. Called by the webview
   * MessageRouter on `workspace-root-changed`. Rejects every in-flight
   * request with a `CancellationError` (so callers re-issue against the
   * new root) but DOES NOT mark this data source disposed — it's still
   * usable for the new generation.
   *
   * Returns the new `workspaceRoot` for the caller to use when re-mounting
   * the tree.
   */
  handleRootChanged(msg: { rootPath: string | null; rootGeneration: number }): void {
    if (this.disposed) {
      return;
    }
    this.workspaceRoot = msg.rootPath;
    this.currentRootGeneration = msg.rootGeneration;
    const err = new CancellationError("Workspace root changed");
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
    // Workspace root rotation invalidates the path cache — old paths may no
    // longer exist (different workspace), and any surviving `FileNode`
    // identities would re-enter the Tree's `nodes` Map under stale paths.
    this.nodeCache.clear();
  }

  /** Test/inspection only — exposes the workspace root the source currently points at. */
  getWorkspaceRoot(): string | null {
    return this.workspaceRoot;
  }

  /** Test/inspection only — exposes the current generation. */
  getRootGeneration(): number {
    return this.currentRootGeneration;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * Reject every parked request with a `CancellationError`, clear the
   * pending map, and mark this data source disposed. After `dispose()`,
   * `readDirectory()` rejects immediately (see the `disposed` guard).
   *
   * Idempotent — calling twice is a no-op.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const err = new CancellationError("FileSystemDataSource disposed");
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
    this.nodeCache.clear();
  }
}
