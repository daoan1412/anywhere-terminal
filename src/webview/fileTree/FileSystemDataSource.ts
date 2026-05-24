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
  RequestSubscribeFsChangesMessage,
  RequestUnsubscribeFsChangesMessage,
} from "../../types/messages";
import type { FolderDirtyCounts } from "./folderDirtyState";
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
 * Apply a single (prev → next) propagating-status transition to one ancestor
 * folder: per-kind bucket adjustments + legacy sum maintenance. When `prev`
 * is set the bucket is decremented (and the key deleted at zero); when `next`
 * is set the bucket is incremented. When the bucket map becomes empty the
 * field is reset to `undefined`. The legacy sum tracks the net `(next?1:0) -
 * (prev?1:0)` and clamps at zero.
 */
function adjustAncestorBuckets(node: FileNode, prev: GitStatus | undefined, next: GitStatus | undefined): void {
  let buckets: FolderDirtyCounts | undefined = node.dirtyDescendantCountsByStatus;
  if (prev !== undefined && buckets !== undefined) {
    const after = (buckets[prev] ?? 0) - 1;
    if (after > 0) {
      buckets[prev] = after;
    } else {
      delete buckets[prev];
    }
  }
  if (next !== undefined) {
    if (buckets === undefined) {
      buckets = {};
      node.dirtyDescendantCountsByStatus = buckets;
    }
    buckets[next] = (buckets[next] ?? 0) + 1;
  }
  if (buckets !== undefined && Object.keys(buckets).length === 0) {
    node.dirtyDescendantCountsByStatus = undefined;
  }

  const sumDelta = (next !== undefined ? 1 : 0) - (prev !== undefined ? 1 : 0);
  if (sumDelta !== 0) {
    const sum = (node.dirtyDescendantCount ?? 0) + sumDelta;
    node.dirtyDescendantCount = sum < 0 ? 0 : sum;
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
  /**
   * Optional panel-injected callback fired on every generation-matched
   * `fs-changes-invalidated`. Receives the parent absolute path; the panel
   * resolves it to a tree node (with the special case where `absPath ===
   * currentRootPath` → refresh the synthetic root held by `Tree.setInput`).
   * Default is a no-op so tests / hosts that don't wire the watcher pool
   * are unaffected.
   *
   * See: asimov/changes/add-file-tree-fs-watcher/design.md D4, D4a.
   */
  onDirectoryInvalidated?: (absPath: string) => void;
  /**
   * Optional panel-injected callback fired on every generation-matched
   * `fs-rehydrate`. The panel refreshes the synthetic root plus every
   * currently-EXPANDED directory (not every cached directory — D7).
   * Default is a no-op.
   */
  onRehydrate?: () => void;
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
  /**
   * Set of absolute directory paths currently subscribed via
   * `subscribeFsChanges`. Tracks the root path separately from `nodeCache`
   * because the root is held by `Tree.setInput` (not `getChildren` —
   * see asimov/changes/add-file-tree-fs-watcher/design.md D4a) and so it
   * never appears in `nodeCache`. Used to (i) idempotency-gate root +
   * directory subscribes so re-encounter doesn't double-post and (ii)
   * compose the bulk unsubscribe list on root change / dispose.
   */
  private readonly subscribedPaths = new Set<string>();

  /**
   * Per-path in-flight `getChildren` read counter. Used by the W2 rollback
   * gate (round-2 oracle) to ONLY tear down a subscription when the rejected
   * read is the LAST in-flight call AND no successful listing landed first.
   * Concurrent `getChildren(samePath)` calls share the same subscription, so
   * one call's rejection must not strip a watcher another call still needs.
   */
  private readonly inflightReadsByPath = new Map<string, number>();

  /**
   * Callback fired on every generation-matched `fs-changes-invalidated`.
   * See `FileSystemDataSourceInit.onDirectoryInvalidated`.
   */
  private readonly onDirectoryInvalidatedCb: (absPath: string) => void;
  /**
   * Callback fired on every generation-matched `fs-rehydrate`. See
   * `FileSystemDataSourceInit.onRehydrate`.
   */
  private readonly onRehydrateCb: () => void;

  constructor(
    init: FileSystemDataSourceInit,
    private readonly postMessage: (
      m: RequestReadDirectoryMessage | RequestSubscribeFsChangesMessage | RequestUnsubscribeFsChangesMessage,
    ) => void,
  ) {
    this.currentRootGeneration = init.rootGeneration;
    this.workspaceRoot = init.workspaceRoot;
    this.onDirectoryInvalidatedCb = init.onDirectoryInvalidated ?? (() => {});
    this.onRehydrateCb = init.onRehydrate ?? (() => {});
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
    // Subscribe the read path itself once. This covers both (a) the root —
    // which is not in `nodeCache` because `Tree.setInput` owns it (D4a) — and
    // (b) any directory whose children are being listed for the first time.
    // The directory's own cache entry (set by the parent's `getChildren` in
    // the freshly-cached branch below) also subscribes; the membership Set
    // dedupes so the host never sees a duplicate subscribe.
    // Subscribe BEFORE the read so a watcher fire that races the listing is
    // not lost. On read failure (round-1 W2) we roll the subscription back
    // — but ONLY when no concurrent reads remain AND no successful listing
    // exists (round-2 oracle). `subscribedPaths` only grows via
    // `ensureSubscribed` from `getChildren`, and `evictSubtree`/`handleRootChanged`
    // clear it in lockstep with `childrenByParent`, so the absence of
    // `childrenByParent[path]` here means every prior subscribe attempt for
    // this path also failed without caching — safe to tear down.
    this.ensureSubscribed(path);
    this.inflightReadsByPath.set(path, (this.inflightReadsByPath.get(path) ?? 0) + 1);
    let entries: FileEntry[];
    try {
      entries = await this.readDirectory(path);
    } catch (err) {
      const remaining = this.decrementInflightRead(path);
      if (remaining === 0 && !this.childrenByParent.has(path) && this.subscribedPaths.delete(path)) {
        this.unsubscribeFsChanges([path]);
      }
      throw err;
    }
    this.decrementInflightRead(path);
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
        if (e.kind === "directory") {
          // Subscribe every newly-cached directory so a paste / rename /
          // delete inside it is reflected in the tree without manual
          // re-expand. Mirrors `nodeCache` lifecycle (D6 — subscribe on
          // cache insert, unsubscribe on eviction).
          this.ensureSubscribed(e.path);
        }
      }
      // Stamp git status through the single transition function. When the
      // entry carries no revision (e.g. tests / hosts without a provider),
      // skip — there's no version to compare against.
      if (e.gitRevision !== undefined) {
        this.applyStatusTransition(node, e.gitStatus, e.gitRevision);
      }
      // Directory entries carry a host-aggregated descendant bucket so the
      // folder badge paints correctly BEFORE its children are loaded
      // (D11). On every directory listing (fresh OR re-stamp) we adopt the
      // snapshot as the authoritative bucket — it counts everything the
      // git provider knows at all depths, which is more accurate than
      // the leaf-walk for unexpanded subtrees. Note: subsequent leaf
      // walks (from `applyStatusTransition`) MAY double-count this bucket
      // for the directory's own direct children once it's expanded, but
      // `dominantDirtyStatus` only checks `> 0` per key — so the badge
      // colour stays correct even when counts inflate.
      if (e.kind === "directory") {
        if (e.dirtyDescendantCountsByStatus !== undefined) {
          node.dirtyDescendantCountsByStatus = { ...e.dirtyDescendantCountsByStatus };
          let sum = 0;
          for (const v of Object.values(node.dirtyDescendantCountsByStatus)) {
            sum += v ?? 0;
          }
          node.dirtyDescendantCount = sum;
        } else if (e.gitRevision !== undefined) {
          // Host stamped this entry (gitRevision present) but reported no
          // dirty descendants — that's authoritative "all clean", not
          // "unknown". Clear any prior bucket/sum so an unexpanded folder
          // doesn't stay tinted after its last dirty descendant was
          // cleaned/deleted. (Round-3 oracle finding.)
          node.dirtyDescendantCountsByStatus = undefined;
          node.dirtyDescendantCount = undefined;
        }
        // No gitRevision → host has no git provider wired (tests / fallback);
        // leave whatever the prior cached value was.
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
        this.walkAncestorsAndAdjust(p, node.gitStatus, undefined);
      }
    }
    // Phase 2: actually delete the cache + per-path state.
    const unsubPaths: string[] = [];
    for (const p of subtree) {
      this.nodeCache.delete(p);
      this.revisionByPath.delete(p);
      this.pendingStatuses.delete(p);
      this.childrenByParent.delete(p);
      if (this.subscribedPaths.delete(p)) {
        unsubPaths.push(p);
      }
    }
    if (unsubPaths.length > 0) {
      this.unsubscribeFsChanges(unsubPaths);
    }
  }

  /**
   * Idempotently subscribe `absPath` once. Centralised so the per-host
   * Set never falls out of sync with the host-side subscription map.
   */
  private ensureSubscribed(absPath: string): void {
    if (this.subscribedPaths.has(absPath)) {
      return;
    }
    this.subscribedPaths.add(absPath);
    this.subscribeFsChanges(absPath);
  }

  /**
   * Decrement the in-flight read counter for `path`. Returns the remaining
   * count (0 when this was the last). Cleans up the map entry at zero so the
   * map doesn't grow unboundedly across the lifetime of the data source.
   */
  private decrementInflightRead(path: string): number {
    const remaining = (this.inflightReadsByPath.get(path) ?? 1) - 1;
    if (remaining <= 0) {
      this.inflightReadsByPath.delete(path);
      return 0;
    }
    this.inflightReadsByPath.set(path, remaining);
    return remaining;
  }

  /**
   * Generation-gated dispatch for `fs-changes-invalidated`. Delegates to the
   * panel-injected `onDirectoryInvalidated` callback WITHOUT pre-filtering on
   * `nodeCache` — the panel resolves `parent` to a tree node, including the
   * special case where `parent === currentRootPath` (the root is held by
   * `Tree.setInput`, not in `nodeCache` — see design.md D4a).
   */
  handleFsChangesInvalidated(msg: { rootGeneration: number; parent: string }): void {
    if (this.disposed) {
      return;
    }
    if (msg.rootGeneration !== this.currentRootGeneration) {
      return;
    }
    this.onDirectoryInvalidatedCb(msg.parent);
  }

  /**
   * Generation-gated dispatch for `fs-rehydrate`. The panel callback refreshes
   * root + currently-expanded directory nodes (not every cached one — see
   * design.md D7).
   */
  handleFsRehydrate(msg: { rootGeneration: number }): void {
    if (this.disposed) {
      return;
    }
    if (msg.rootGeneration !== this.currentRootGeneration) {
      return;
    }
    this.onRehydrateCb();
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
    node.gitStatus = next;
    const prevPropagating = isDirtyForPropagation(prevStatus) ? prevStatus : undefined;
    const nextPropagating = isDirtyForPropagation(next) ? next : undefined;
    if (prevPropagating !== nextPropagating) {
      this.walkAncestorsAndAdjust(node.path, prevPropagating, nextPropagating);
    }
    return true;
  }

  /**
   * Walk every cached ancestor of `absPath` and update its
   * `dirtyDescendantCountsByStatus` buckets (per-kind) plus
   * `dirtyDescendantCount` (legacy sum). When `prev` is set, decrement that
   * bucket; when `next` is set, increment that bucket. The sum tracks the
   * net change (`-1`/`0`/`+1`). Stops at the first cache miss — uncached
   * ancestors cannot render badges. Clamps at zero to defend against any
   * single-event drift (refcount-drift symptom).
   */
  private walkAncestorsAndAdjust(absPath: string, prev: GitStatus | undefined, next: GitStatus | undefined): void {
    let current = dirname(absPath);
    while (current && current !== absPath) {
      const ancestor = this.nodeCache.get(current);
      if (!ancestor) {
        break;
      }
      adjustAncestorBuckets(ancestor, prev, next);
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

  /**
   * Request the extension host to start watching `path` for create/delete
   * events. Fire-and-forget — host posts `fs-changes-invalidated` back
   * asynchronously when the debounced watcher fires.
   *
   * See: asimov/changes/add-file-tree-fs-watcher/specs/file-tree-rpc/spec.md.
   */
  subscribeFsChanges(path: string): void {
    if (this.disposed) {
      return;
    }
    this.postMessage({
      type: "request-subscribe-fs-changes",
      rootGeneration: this.currentRootGeneration,
      path,
    });
  }

  /**
   * Request the extension host to stop watching the given paths. Fire-and-
   * forget; unknown paths are silently ignored host-side. The bulk shape
   * keeps eviction of a subtree to one round-trip.
   */
  unsubscribeFsChanges(paths: string[]): void {
    if (this.disposed) {
      return;
    }
    if (paths.length === 0) {
      return;
    }
    this.postMessage({
      type: "request-unsubscribe-fs-changes",
      rootGeneration: this.currentRootGeneration,
      paths,
    });
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
    // Bulk-unsubscribe every previously-subscribed path BEFORE clearing local
    // state. The host-side per-host subscription map is keyed by absolute
    // path; on the new generation, those entries would otherwise leak until
    // the host's own attach()-cleanup fires (e.g. on webview disposal).
    if (this.subscribedPaths.size > 0) {
      const paths = [...this.subscribedPaths];
      this.subscribedPaths.clear();
      // Use the bumped generation so the host gates the unsubscribe under
      // the new value — symmetric with how subsequent subscribes will be
      // posted. (The host's per-host map is path-keyed and tolerates either
      // generation, but staying consistent simplifies log auditing.)
      this.currentRootGeneration = msg.rootGeneration;
      this.unsubscribeFsChanges(paths);
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
    // Bulk-unsubscribe BEFORE marking disposed so `unsubscribeFsChanges`'s
    // own `disposed` guard doesn't swallow the send. Order matters because
    // unsubscribe posts a message, and `disposed` short-circuits that path.
    if (this.subscribedPaths.size > 0) {
      const paths = [...this.subscribedPaths];
      this.subscribedPaths.clear();
      this.unsubscribeFsChanges(paths);
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
