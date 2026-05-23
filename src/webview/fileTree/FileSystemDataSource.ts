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

import type {
  FileEntry,
  GitStatus,
  ReadDirectoryResponseMessage,
  RequestReadDirectoryMessage,
} from "../../types/messages";
import type { FileNode, FileStat, IFileSystemProvider } from "./IFileSystemProvider";
import type { ITreeDataSource } from "./ITreeDataSource";

/** POSIX-and-Windows-safe parent path; returns null when no parent (root or basename-only). */
function dirname(p: string): string | null {
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (lastSlash === -1) {
    return null;
  }
  // Preserve a leading "/" for POSIX roots — `/a` → `/`, but `/` → null.
  if (lastSlash === 0) {
    return p.length === 1 ? null : "/";
  }
  return p.slice(0, lastSlash);
}

/**
 * Statuses that "propagate" — a file in any of these makes ancestor folders
 * render their dirty badge. `deleted` and `ignored` deliberately do not
 * propagate (mirrors VS Code; see design.md D6).
 */
function isDirtyForPropagation(status: GitStatus | undefined): boolean {
  switch (status) {
    case "modified":
    case "added":
    case "renamed":
    case "untracked":
    case "conflicted":
      return true;
    default:
      return false;
  }
}

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
  /**
   * Per-path revision at which `FileNode.gitStatus` was last set. Guards the
   * single transition function from applying older snapshots over a newer
   * delta (D10). Keyed by absolute path; cleared on `handleRootChanged`.
   */
  private readonly revisionByPath = new Map<string, number>();
  /**
   * Status updates that arrived before the containing directory was loaded.
   * Drained the moment a matching `FileNode` lands in the cache. Cleared on
   * `handleRootChanged`. See: design.md D10, spec § "Pending status for
   * late-arriving directories".
   *
   * Revision-guarded (O-W1): a delta carrying a revision older than what's
   * already in the pending entry is rejected, mirroring the
   * `applyStatusTransition` watermark for cached nodes. Without this guard,
   * a late-arriving older delta could overwrite a newer pending status for
   * an unknown path.
   */
  private readonly pendingStatuses = new Map<string, { status: GitStatus | null; revision: number }>();
  /**
   * Reverse index: parent absolute path → set of last-known child absolute
   * paths from the most recent `getChildren` call. Used to evict stale
   * `nodeCache` entries when a path disappears from a later listing (O-W2).
   * Without this, a file removed from disk would leave its `FileNode` cached
   * forever — a memory leak bounded by workspace size but unbounded by time.
   */
  private readonly childrenByParent = new Map<string, Set<string>>();

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
    // ignored) so consumers observe the latest backend state. Git status is
    // funneled through `applyStatusTransition` so the per-path revision guard
    // and ancestor refcount stay correct (D11).
    const newChildPaths = new Set<string>();
    const result = entries.map((e) => {
      newChildPaths.add(e.path);
      const cached = this.nodeCache.get(e.path);
      let node: FileNode;
      let isFreshlyCached = false;
      if (cached) {
        cached.name = e.name;
        cached.kind = e.kind;
        cached.ignored = e.ignored;
        node = cached;
      } else {
        node = {
          name: e.name,
          path: e.path,
          kind: e.kind,
          ignored: e.ignored,
        };
        this.nodeCache.set(e.path, node);
        isFreshlyCached = true;
      }
      // Stamp git status through the single transition function. When the
      // entry carries no revision (e.g. tests / hosts without a provider),
      // skip — there's no version to compare against.
      if (e.gitRevision !== undefined) {
        this.applyStatusTransition(node, e.gitStatus, e.gitRevision);
      }
      // Drain any pending status that arrived before this directory loaded.
      // The transition function's own revision guard decides whether the
      // pending value or the snapshot wins.
      if (isFreshlyCached) {
        const pending = this.pendingStatuses.get(e.path);
        if (pending !== undefined) {
          this.pendingStatuses.delete(e.path);
          this.applyStatusTransition(node, pending.status ?? undefined, pending.revision);
        }
      }
      return node;
    });
    // O-W2: Evict cache entries for paths that disappeared from this
    // listing. In normal operation git emits the corresponding `deleted` /
    // `null` delta first (so the leaf is no longer dirty by the time we
    // evict), but a race or out-of-band disk change could leave a dirty
    // leaf in the subtree we evict. We walk the subtree via
    // `childrenByParent` and adjust ancestor refcounts for any dirty leaf
    // BEFORE deleting cache entries — otherwise the ancestor walk would
    // break early on a missing intermediate.
    const oldChildren = this.childrenByParent.get(path);
    if (oldChildren) {
      for (const oldPath of oldChildren) {
        if (!newChildPaths.has(oldPath)) {
          this.evictSubtree(oldPath);
        }
      }
    }
    this.childrenByParent.set(path, newChildPaths);
    return result;
  }

  /**
   * Evict an absolute path and every cached descendant via BFS over
   * `childrenByParent`. Refcount drift defense (O-W2): for each dirty leaf
   * inside the subtree, walk ancestors with `-1` while cache is still
   * intact, then delete all subtree entries.
   */
  private evictSubtree(rootPath: string): void {
    const subtree: string[] = [];
    const stack = [rootPath];
    while (stack.length > 0) {
      const p = stack.pop();
      if (p === undefined) {
        break;
      }
      subtree.push(p);
      const kids = this.childrenByParent.get(p);
      if (kids) {
        for (const k of kids) {
          stack.push(k);
        }
      }
    }
    // Phase 1: subtract dirty contributions from external ancestors. Must
    // happen before deletion so the walk doesn't break on a missing
    // intermediate cache entry. Walks that pass through evicted-but-not-yet-
    // deleted folders inside the subtree harmlessly tick their counters —
    // those folders are about to be removed.
    for (const p of subtree) {
      const node = this.nodeCache.get(p);
      if (node && isDirtyForPropagation(node.gitStatus)) {
        this.walkAncestorsAndAdjust(p, -1);
      }
    }
    // Phase 2: actually delete the cache + per-path state.
    for (const p of subtree) {
      this.nodeCache.delete(p);
      this.revisionByPath.delete(p);
      this.pendingStatuses.delete(p);
      this.childrenByParent.delete(p);
    }
  }

  /**
   * Apply an incremental git-status delta. Routes every change through the
   * single `applyStatusTransition` writer for nodes already cached; stashes
   * status for paths whose containing directory hasn't loaded yet so it can
   * be applied on the next insert. `status: null` clears any matching
   * pending entry to bound the map's growth (spec § "Pending status for
   * late-arriving directories").
   *
   * See: asimov/changes/add-file-tree-git-decorations/design.md D10, D11.
   */
  applyGitStatusDelta(revision: number, changes: ReadonlyArray<{ path: string; status: GitStatus | null }>): boolean {
    if (this.disposed) {
      return false;
    }
    let changed = false;
    for (const c of changes) {
      const node = this.nodeCache.get(c.path);
      if (node) {
        changed = this.applyStatusTransition(node, c.status ?? undefined, revision) || changed;
        if (c.status === null) {
          // Status cleared — also drop any stale pending entry.
          this.pendingStatuses.delete(c.path);
        }
      } else {
        // O-W1: Revision-guard the pending entry. A delta carrying an older
        // revision than what's already pending is rejected, mirroring the
        // `applyStatusTransition` watermark for cached nodes. Without this
        // guard, a stale delta arriving after a newer one could clear or
        // overwrite the fresher pending value for an unknown path.
        const existing = this.pendingStatuses.get(c.path);
        if (existing !== undefined && revision <= existing.revision) {
          continue;
        }
        if (c.status === null) {
          // Nothing to clear in the cache and we don't want to store
          // "becomes clean" speculatively — drop.
          this.pendingStatuses.delete(c.path);
        } else {
          this.pendingStatuses.set(c.path, { status: c.status, revision });
        }
      }
    }
    return changed;
  }

  /**
   * The single allowed writer of `FileNode.gitStatus` and
   * `FileNode.dirtyDescendantCount`. Implements D10 (revision-guarded apply)
   * + D11 (snapshot / delta / pending all funnel here). Snapshot, delta, and
   * the pending-status drain on cache insert all call this function — there
   * is no other path that mutates these fields.
   */
  private applyStatusTransition(node: FileNode, next: GitStatus | undefined, revision: number): boolean {
    const stored = this.revisionByPath.get(node.path);
    if (stored !== undefined && revision <= stored) {
      // Older or equal — reject. (Equal is a no-op rather than an error so a
      // double-apply within the same batch is harmless.)
      return false;
    }
    this.revisionByPath.set(node.path, revision);
    const prevStatus = node.gitStatus;
    if (prevStatus === next) {
      // No state change beyond bumping the revision watermark.
      return false;
    }
    const prevDirty = isDirtyForPropagation(prevStatus);
    const nextDirty = isDirtyForPropagation(next);
    node.gitStatus = next;
    if (prevDirty === nextDirty) {
      return true;
    }
    const delta = nextDirty ? 1 : -1;
    this.walkAncestorsAndAdjust(node.path, delta);
    return true;
  }

  /**
   * Walk every cached ancestor of `absPath` and add `delta` to its
   * `dirtyDescendantCount`. Stops as soon as a cache miss is hit — uncached
   * paths cannot render badges anyway, so we save the work. Clamps at zero
   * to defend against any one-off underflow (refcount drift symptom).
   */
  private walkAncestorsAndAdjust(absPath: string, delta: number): void {
    let current = dirname(absPath);
    while (current && current !== absPath) {
      const ancestor = this.nodeCache.get(current);
      if (!ancestor) {
        break;
      }
      const next = (ancestor.dirtyDescendantCount ?? 0) + delta;
      ancestor.dirtyDescendantCount = next < 0 ? 0 : next;
      const parent = dirname(current);
      if (!parent || parent === current) {
        break;
      }
      current = parent;
    }
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
    // Drop the per-path revision watermark too — a new root starts at
    // revision 0 from the (reset) decoration provider, so retaining old
    // watermarks would reject the legitimate first-snapshot stamping.
    this.revisionByPath.clear();
    this.pendingStatuses.clear();
    this.childrenByParent.clear();
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
    this.revisionByPath.clear();
    this.pendingStatuses.clear();
    this.childrenByParent.clear();
  }

  /**
   * Inspect-only accessor used by search-row rendering (see spec § "Flat-list /
   * search mode honors decorations via cache lookup"). Returns the cached
   * `FileNode` for an absolute path, or undefined when the path hasn't been
   * loaded into the tree yet.
   */
  getCachedNode(absPath: string): FileNode | undefined {
    return this.nodeCache.get(absPath);
  }
}
