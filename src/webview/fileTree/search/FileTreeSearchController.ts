// src/webview/fileTree/search/FileTreeSearchController.ts — Webview-side
// orchestrator for the in-panel file-tree search.
//
// Owns the search lifecycle: enter / setQuery / setMode / exit. Talks to:
//   - the extension host via `RequestFileTreeSearch` postMessage
//   - the `Tree<FileNode>` via `setFlatItems` for result presentation
//   - the `matching` module for client-side fuzzy scoring
//
// Caching strategy (D11): ONE enumeration RPC per (scope, rootGeneration).
// Subsequent keystrokes re-score the cached list client-side without RPC.
// The cache invalidates on workspace root change, scope change, or 60s TTL.

import type {
  CancelFileTreeSearchMessage,
  FileTreeSearchResponseMessage,
  FileTreeSearchResult,
  RequestFileTreeSearchMessage,
} from "../../../types/messages";
import type { FileNode, SearchRowMeta } from "../IFileSystemProvider";
import type { ITreeMatchData } from "../ITreeRenderer";
import type { Tree } from "../Tree";
import { type SearchMode, scoreAndSort } from "./matching";

/** Default cap for the enumeration RPC. */
export const DEFAULT_MAX_RESULTS = 2000;
/** Default debounce for the initial enumeration after `enter()` / first keystroke. */
export const ENUMERATION_DEBOUNCE_MS = 200;
/** Cache TTL — guards against silent fs changes during a long-lived session. */
export const CACHE_TTL_MS = 60_000;

/** Sentinel `path` value used by synthetic overflow-footer rows. */
export const OVERFLOW_SENTINEL_PATH = "__overflow__";
/** Sentinel `path` value used by synthetic error-marker rows. */
export const ERROR_SENTINEL_PATH = "__error__";

/** Minimal post surface — production wires this to the webview's vscode-api postMessage. */
export type SearchPost = (msg: RequestFileTreeSearchMessage | CancelFileTreeSearchMessage) => void;

interface CacheEntry {
  readonly scope: string;
  readonly rootGeneration: number;
  readonly results: ReadonlyArray<FileTreeSearchResult>;
  readonly truncated: boolean;
  readonly fetchedAt: number;
}

/**
 * Construction dependencies for the controller. All explicit — no globals.
 */
export interface FileTreeSearchControllerDeps {
  /** The tree that hosts search results in flat-list mode. */
  readonly tree: Pick<Tree<FileNode>, "setFlatItems">;
  /** Outbound: post a search-enumeration request to the extension host. */
  readonly post: SearchPost;
  /** Read the current host-side `rootGeneration` (mirrored from `InitMessage` + bumps). */
  readonly getRootGeneration: () => number;
  /**
   * Optional ID generator for `requestId`. Defaults to a monotonic counter so
   * tests have deterministic IDs.
   */
  readonly nextRequestId?: () => string;
  /** Optional override for the cap. */
  readonly maxResults?: number;
}

let _autoId = 0;
function defaultNextRequestId(): string {
  _autoId += 1;
  return `search-${_autoId}`;
}

function makeSearchRowNode(result: FileTreeSearchResult, variant: "match" | "non-match"): FileNode {
  return {
    name: result.relativePath,
    path: result.absolutePath,
    kind: "file",
    searchRow: { relativePath: result.relativePath, variant },
  };
}

function makeOverflowFooterNode(): FileNode {
  return {
    name: "Showing first 2000 files in scope — narrow your scope to see more",
    path: OVERFLOW_SENTINEL_PATH,
    kind: "file",
    searchRow: { relativePath: OVERFLOW_SENTINEL_PATH, variant: "overflow-footer" },
  };
}

function makeErrorMarkerNode(message: string): FileNode {
  return {
    name: message,
    path: ERROR_SENTINEL_PATH,
    kind: "file",
    searchRow: { relativePath: ERROR_SENTINEL_PATH, variant: "error", errorMessage: message },
  };
}

/**
 * Whether a `FileNode` is the synthetic overflow footer / error marker.
 * Renderer + click handlers consult this to disable activation.
 */
export function isSyntheticSearchRow(node: FileNode): boolean {
  const v: SearchRowMeta["variant"] | undefined = node.searchRow?.variant;
  return v === "overflow-footer" || v === "error";
}

export class FileTreeSearchController {
  private readonly tree: FileTreeSearchControllerDeps["tree"];
  private readonly post: SearchPost;
  private readonly getRootGeneration: () => number;
  private readonly nextRequestId: () => string;
  private readonly maxResults: number;

  /** Current scope path (absolute). Null when not in search-active mode. */
  private scope: string | null = null;
  private query = "";
  private mode: SearchMode = "filter";
  private cache: CacheEntry | null = null;
  /** ID of the in-flight RPC, if any. */
  private pendingRequestId: string | null = null;
  /** Debounce timer for the initial enumeration. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: FileTreeSearchControllerDeps) {
    this.tree = deps.tree;
    this.post = deps.post;
    this.getRootGeneration = deps.getRootGeneration;
    this.nextRequestId = deps.nextRequestId ?? defaultNextRequestId;
    this.maxResults = deps.maxResults ?? DEFAULT_MAX_RESULTS;
  }

  /** True when the controller is currently in search-active mode. */
  isActive(): boolean {
    return this.scope !== null;
  }

  /** Enter search-active mode pinned to `scope` (an absolute folder path). */
  enter(scope: string, initialMode: SearchMode = "filter"): void {
    // If the retained cache belongs to a different scope, drop it. `exit()`
    // clears `this.scope`, so compare against the cache's pinned scope rather
    // than the controller's current active-scope slot.
    if (this.cache && this.cache.scope !== scope) {
      this.cache = null;
    }
    this.scope = scope;
    this.query = "";
    this.mode = initialMode;
    // Render immediately so the user sees flat-list mode kick in without
    // waiting for the RPC. If a fresh cache survived a prior exit/re-entry,
    // do not re-enumerate the same (scope, rootGeneration) tuple.
    this.renderFromCacheOrEmpty();
    if (!this.cacheIsFresh()) {
      this.scheduleEnumeration();
    }
  }

  /** Update the query text. Re-render from cache, or trigger a debounced RPC. */
  setQuery(query: string): void {
    this.query = query;
    if (this.cacheIsFresh()) {
      this.render();
      return;
    }
    this.scheduleEnumeration();
  }

  /** Switch between Filter and Highlight modes. Re-render from cache only. */
  setMode(mode: SearchMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    if (this.cacheIsFresh()) {
      this.render();
    }
  }

  /**
   * Handle a response from the extension host. Returns `true` if the message
   * was consumed (i.e., it was a `file-tree-search-response` addressed to our
   * latest in-flight requestId), `false` if it was unrelated or stale.
   */
  onResponse(msg: FileTreeSearchResponseMessage): boolean {
    if (msg.requestId !== this.pendingRequestId) {
      return false;
    }
    this.pendingRequestId = null;

    if (msg.rootGeneration !== this.getRootGeneration()) {
      return true;
    }

    if (msg.error) {
      this.cache = null;
      this.tree.setFlatItems([makeErrorMarkerNode(msg.error.message)]);
      return true;
    }

    if (this.scope === null) {
      // We exited search mode while the response was in flight — drop.
      return true;
    }

    this.cache = {
      scope: this.scope,
      rootGeneration: msg.rootGeneration,
      results: msg.results ?? [],
      truncated: msg.truncated === true,
      fetchedAt: Date.now(),
    };
    this.render();
    return true;
  }

  /**
   * Drop the cached enumeration when an external FS change touched the
   * controller's currently-pinned scope. Wired by `FileTreePanel` into the
   * same callback that drives tree refresh on `fs-changes-invalidated` so
   * search results no longer go stale within the 60 s TTL window after a
   * paste / rename / delete done in VS Code Explorer or any shell.
   *
   *   - `absPath === scope` OR `absPath` is a descendant of scope → drop
   *     cache; if search is currently active, reschedule the enumeration so
   *     the user sees fresh results on the next render tick.
   *   - Otherwise → no-op (the change is outside the scope we enumerate).
   *
   * See: asimov/changes/add-file-tree-fs-watcher/design.md D9.
   */
  onFsInvalidated(absPath: string): void {
    if (!this.cache) {
      return;
    }
    const scope = this.cache.scope;
    // Handle BOTH `/` (POSIX) and `\` (Windows) — `absPath` arrives in
    // host-native format. Browser-bundle constraint forbids `node:path`.
    if (absPath === scope) {
      this.invalidateCache();
      return;
    }
    const sep = scope.includes("\\") && !scope.includes("/") ? "\\" : "/";
    const boundary = scope.endsWith(sep) ? scope : scope + sep;
    if (absPath.startsWith(boundary)) {
      this.invalidateCache();
    }
  }

  /**
   * Drop the cached enumeration unconditionally (window-focus rising edge
   * from `WatcherPool`). When search is active, reschedule the enumeration
   * so results refresh on the next render tick.
   *
   * See: asimov/changes/add-file-tree-fs-watcher/design.md D7, D9.
   */
  onRehydrate(): void {
    if (!this.cache) {
      return;
    }
    this.invalidateCache();
  }

  private invalidateCache(): void {
    this.cache = null;
    if (this.isActive()) {
      this.scheduleEnumeration();
    }
  }

  /**
   * Notify the controller that the workspace root changed. Invalidates the
   * cache and drops any in-flight requestId. Also tells the host to cancel
   * any in-flight enumeration that would otherwise run to completion before
   * its response is dropped at our `onResponse` stale-generation check.
   */
  onWorkspaceRootChanged(): void {
    const hadPending = this.pendingRequestId !== null || this.debounceTimer !== null;
    this.cache = null;
    this.pendingRequestId = null;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (hadPending) {
      this.post({ type: "cancel-file-tree-search" });
    }
  }

  /**
   * Exit search-active mode. Restores the tree to its prior state via
   * `setFlatItems(null)` (the Tree itself preserves the snapshot). Cache is
   * NOT cleared on exit — a re-entry with the same scope/rootGen and
   * within TTL skips the RPC. Tells the host to cancel any in-flight
   * enumeration so it doesn't run to completion just to have its response
   * dropped on arrival (Esc / panel close on a slow filesystem).
   */
  exit(): void {
    const hadPending = this.pendingRequestId !== null || this.debounceTimer !== null;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingRequestId = null;
    this.scope = null;
    this.query = "";
    this.tree.setFlatItems(null);
    if (hadPending) {
      this.post({ type: "cancel-file-tree-search" });
    }
  }

  // ─── Internals ────────────────────────────────────────────────────

  private cacheIsFresh(): boolean {
    const c = this.cache;
    if (!c) {
      return false;
    }
    if (c.scope !== this.scope) {
      return false;
    }
    if (c.rootGeneration !== this.getRootGeneration()) {
      return false;
    }
    if (Date.now() - c.fetchedAt > CACHE_TTL_MS) {
      return false;
    }
    return true;
  }

  private scheduleEnumeration(): void {
    if (this.scope === null) {
      return;
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.fireEnumeration();
    }, ENUMERATION_DEBOUNCE_MS);
  }

  private fireEnumeration(): void {
    if (this.scope === null) {
      return;
    }
    const requestId = this.nextRequestId();
    this.pendingRequestId = requestId;
    this.post({
      type: "request-file-tree-search",
      requestId,
      rootGeneration: this.getRootGeneration(),
      scopePath: this.scope,
      maxResults: this.maxResults,
    });
  }

  private render(): void {
    if (!this.cache) {
      this.renderFromCacheOrEmpty();
      return;
    }
    const scored = scoreAndSort(this.query, this.cache.results, this.mode);
    const items: FileNode[] = [];
    const matchMap = new Map<FileNode, ITreeMatchData>();
    for (const c of scored) {
      const variant = c.matchData ? "match" : "non-match";
      const node = makeSearchRowNode(c.result, variant);
      items.push(node);
      if (c.matchData) {
        matchMap.set(node, c.matchData);
      }
    }
    if (this.cache.truncated) {
      items.push(makeOverflowFooterNode());
    }
    this.tree.setFlatItems(items, matchMap);
  }

  private renderFromCacheOrEmpty(): void {
    if (this.cacheIsFresh()) {
      this.render();
    } else {
      this.tree.setFlatItems([]);
    }
  }
}
