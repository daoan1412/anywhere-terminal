// src/webview/fileTree/FileTreePanel.ts — Composed file-tree panel for the webview.
//
// Wires together:
//   - `Tree<FileNode>` (the generic widget on top of vendored listWidget)
//   - `FileSystemDataSource` (rootGeneration-aware RPC client)
//   - `ReadOnlyFileRenderer` (the row template)
//
// Owned behavior:
//   - Click activation: directory rows toggle expand/collapse; file rows post
//     `OpenFileMessage` with the active terminal's `sessionId` (resolved lazily
//     via the injected getter — same pattern `DragDropHandler` uses).
//   - Empty state: when no workspace folder is open, render a placeholder div.
//
// NOT owned by this file (other tasks):
//   - Drag-to-terminal (task 5_2: extends ReadOnlyFileRenderer with `draggable`)
//   - Position layout (task 4_3: top/bottom/left/right wrapping)
//   - Toggle command (task 4_4)
//   - Theme variables (task 4_6)
//   - State persistence (task 4_5)
//   - Workspace-root change handling (task 3_5)
//
// See: asimov/changes/port-vscode-async-data-tree/specs/file-tree-panel/spec.md

import type {
  CancelFileTreeSearchMessage,
  FileTreePosition,
  FileTreeSearchResponseMessage,
  OpenFileMessage,
  ReadDirectoryResponseMessage,
  RequestFileTreeSearchMessage,
  RequestReadDirectoryMessage,
  RequestSetFileTreePositionMessage,
} from "../../types/messages";
import type { FileTreeState } from "../state/WebviewState";
import { FileSystemDataSource } from "./FileSystemDataSource";
import { FileTreeSash, isHorizontalLayout } from "./FileTreeSash";
import type { FileNode } from "./IFileSystemProvider";
import { FILE_TREE_DRAG_MIME, ReadOnlyFileRenderer } from "./ReadOnlyFileRenderer";
import { FileTreeSearchController, isSyntheticSearchRow } from "./search/FileTreeSearchController";
import type { SearchMode } from "./search/matching";
import { Tree } from "./Tree";

// `postMessage` accepts all outbound types this panel can send. Kept as a
// union (not `unknown`) so call sites get type-checking but the consumer can
// pass through their existing webview vscode-api `postMessage` shape.
export type FileTreePostMessage = (
  m:
    | RequestReadDirectoryMessage
    | OpenFileMessage
    | RequestSetFileTreePositionMessage
    | RequestFileTreeSearchMessage
    | CancelFileTreeSearchMessage,
) => void;

/**
 * Construction dependencies for `FileTreePanel`. All explicit — the panel
 * pulls no DOM globals (`document` is fine; it's just a webview environment
 * concern, not test boundary).
 */
export interface FileTreePanelDeps {
  /** The DOM host element. The panel attaches its tree (or empty-state) into this node. */
  host: HTMLElement;
  /** Absolute path of the first workspace folder, or null when no workspace open. */
  workspaceRoot: string | null;
  /** Initial `rootGeneration` — pinned from `InitMessage`. */
  rootGeneration: number;
  /**
   * Returns the currently-active terminal pane's `sessionId` (or null). The
   * file-tree posts `OpenFileMessage` with this on every file click so the
   * extension's `openFile` handler accepts it (it requires `sessionId`).
   * The same helper is used by `DragDropHandler` — single source of truth.
   */
  getActiveSessionId: () => string | null;
  /** Webview-side `vscode.postMessage` shim. */
  postMessage: FileTreePostMessage;
  /**
   * Outer flex wrapper element. The panel sets a `file-tree--{top|bottom|left|right}`
   * class on this element when `setPosition` is called. The wrapper is created
   * + owned by `main.ts` (the composition root); FileTreePanel only toggles the
   * class. Optional — when omitted (e.g. in unit tests), `setPosition` is still
   * called but the class-toggle is a no-op.
   */
  layoutWrapper?: HTMLElement;
  /**
   * Called after every `setPosition`, `setOpen(true)`, `setOpen(false)`, and
   * `handleRootChanged` so the caller can re-trigger xterm `fit()` (typically
   * `ResizeCoordinator.debouncedFit`). Optional in tests.
   */
  onLayoutChange?: () => void;
  /**
   * Returns the previously-persisted `FileTreeState`, or `undefined` if the
   * panel has never been shown before. Read once on mount to seed `open`,
   * `position`, and `expandedPaths`. Optional in tests.
   */
  getPersistedState?: () => FileTreeState | undefined;
  /**
   * Called whenever the persisted-state-relevant inputs change
   * (`setPosition`, `setOpen`, expand, collapse). Optional in tests.
   */
  persistState?: (state: FileTreeState) => void;
}

const EMPTY_STATE_CLASS = "file-tree-empty";
const EMPTY_STATE_TEXT = "No folder open. Open a folder to see its files here.";
const POSITION_CLASS_PREFIX = "file-tree--";
const POSITIONS: readonly FileTreePosition[] = ["top", "bottom", "left", "right"];
/** Pixel size used the first time the panel mounts at each orientation. */
const DEFAULT_SIZE_HORIZONTAL = 240; // left/right (width)
const DEFAULT_SIZE_VERTICAL = 200; // top/bottom (height)
/** Hard floor — below this the file names become unreadable. */
const MIN_SIZE = 120;

export class FileTreePanel {
  private tree: Tree<FileNode> | null = null;
  private dataSource: FileSystemDataSource | null = null;
  private emptyStateEl: HTMLElement | null = null;
  /** Mirrors Tree's expansion state for click-to-toggle decisions (Tree itself does not expose `isExpanded`). */
  private readonly expandedPaths = new Set<string>();
  private disposed = false;
  /** Listener detacher for the tree's dragover-reject — re-bound after re-mount. */
  private dragoverDetach: (() => void) | null = null;
  /** Latest position applied — kept so `setOpen` can re-stamp after toggling closed. */
  private currentPosition: FileTreePosition = "bottom";
  /** Latest open state — keeps `setOpen(true|false)` idempotent. */
  private open = true;
  /**
   * Forwards host size changes down to `Tree.layout()`. Without this, the
   * vendored List widget never knows its viewport height, so virtualisation
   * only materialises 1 row regardless of how tall the panel is in CSS.
   */
  private resizeObserver: ResizeObserver | null = null;
  /** Current panel size in CSS pixels — applied via `--file-tree-size`. */
  private currentSize: number;
  /** Resize boundary controller (drag-to-resize). Constructed lazily on first mount. */
  private sash: FileTreeSash | null = null;
  /** Root FileNode used by `setInput` — kept so `revealPath` can walk from it. */
  private rootNode: FileNode | null = null;
  /** Absolute workspace root path — pinned at mount, rotated via `handleRootChanged`. */
  private workspaceRootPath: string | null = null;
  /**
   * Latest workspace-root generation. Initialized from `deps.rootGeneration`
   * and bumped by `handleRootChanged`. `setRoot` (out-of-root reveal) uses
   * this value, NOT the constructor-time `deps.rootGeneration` — otherwise
   * a `revealPath` after a workspace-folder change would mount a new data
   * source pinned to the stale init-time generation, and every directory
   * read would be silently dropped by the host's STALE_ROOT check.
   */
  private currentRootGeneration: number;
  /** Clickable root row inside the header — chevron + name. Used by `syncHeaderRoot` to stamp aria-expanded. */
  private headerRootRowEl: HTMLElement | null = null;
  /** Name span inside the header root row — updated whenever the workspace root changes. */
  private headerRootNameEl: HTMLElement | null = null;
  /** Header search-toggle button — flips between `$(search)` and `$(close)` while in search mode. */
  private headerSearchBtnEl: HTMLElement | null = null;
  /** Body container — the Tree (or empty state) mounts inside this, not into `host`. */
  private bodyEl: HTMLElement | null = null;
  /**
   * Whether the panel is in search-active mode. Transient — never persisted.
   * See: asimov/changes/add-file-tree-search/design.md D9.
   */
  private searchActive = false;
  /** Search controller — lazily constructed on first `enterSearch()`. */
  private searchController: FileTreeSearchController | null = null;
  /** Search-bar DOM (input + mode toggle). Owned by `mountHeader`. */
  private searchBarEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private searchModeFilterBtn: HTMLButtonElement | null = null;
  private searchModeHighlightBtn: HTMLButtonElement | null = null;
  /** Currently-resolved search scope (absolute path). Captured at entry. */
  private currentSearchScope: string | null = null;

  constructor(private readonly deps: FileTreePanelDeps) {
    // Stamp the panel CSS class on the host so theme / position rules in
    // fileTreePanel.css match.
    deps.host.classList.add("file-tree-panel");
    this.currentRootGeneration = deps.rootGeneration;

    // Header + body — created once, survive Tree teardown / re-mount. Tree (and
    // empty-state) mount inside `bodyEl`, so `handleRootChanged`'s
    // `replaceChildren()` on `bodyEl` doesn't wipe the toolbar button.
    this.mountHeader();
    this.mountBody();

    // Seed open + position + expandedPaths from persisted state if present.
    const persisted = deps.getPersistedState?.();
    if (persisted) {
      this.open = persisted.open;
      this.currentPosition = persisted.position;
      for (const path of persisted.expandedPaths) {
        this.expandedPaths.add(path);
      }
    }
    this.currentSize = persisted?.size ?? this.defaultSizeFor(this.currentPosition);

    if (deps.workspaceRoot === null) {
      this.mountEmptyState();
      return;
    }
    this.mountTree(deps.workspaceRoot);
    // Sash + size CSS var must be applied AFTER the panel host has been
    // attached to the tree. Position class lands when main.ts calls
    // `setPosition` shortly after construction; the size variable is
    // independent and safe to write now.
    this.applySize(this.currentSize);
    this.recreateSash();
  }

  private defaultSizeFor(pos: FileTreePosition): number {
    return pos === "left" || pos === "right" ? DEFAULT_SIZE_HORIZONTAL : DEFAULT_SIZE_VERTICAL;
  }

  /**
   * Click/Enter handler invoked from Tree.onDidActivate. Exposed publicly so
   * unit tests can exercise the routing logic without forcing a full async
   * mount + simulated click. Production callers should NOT call this — the
   * Tree fires it automatically.
   */
  /**
   * Reveal the file/folder at `absPath` in the tree.
   *
   * If `absPath` is inside the current tree root, walks segments from the
   * root, expanding each ancestor (lazy-loading via the data source) and
   * finally scrolling the leaf into view + selecting it.
   *
   * If `absPath` is OUTSIDE the current tree root (e.g. shell `cd`'d to a
   * different repo than the workspace folder), tears the tree down and
   * re-roots it at `absPath`. The new root becomes the tree's top-level
   * folder; the user can browse inside it but won't see ancestors above it.
   *
   * Opens the panel if it's currently closed.
   */
  async revealPath(absPath: string, opts?: { focusNoScroll?: boolean; source?: "osc7" | "autoReveal" }): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Auto-reveal panel-hidden gate: don't auto-open the tree just because the
    // user switched editor tabs. The OSC 7 path (no source, or source 'osc7')
    // still opens the panel below.
    if (opts?.source === "autoReveal" && !this.open) {
      return;
    }
    // Make sure the panel is visible before we try to scroll the row.
    if (!this.open) {
      this.setOpen(true);
    }

    const focusNoScroll = opts?.focusNoScroll === true;
    // Auto-reveal anchors the row in the middle of the viewport so siblings
    // remain visible — matches VS Code's explorer behavior. OSC 7 keeps the
    // existing minimum-scroll behavior (no relativeTop) so right-click "Reveal
    // in File Tree" reveal UX is unchanged.
    const revealRelativeTop = opts?.source === "autoReveal" ? 0.5 : undefined;

    // Out-of-current-root path or no tree mounted (empty state) → re-root.
    // Use `isPathInside` (not raw `startsWith`) so `/work/repo2/x` doesn't
    // get treated as inside `/work/repo`.
    const outOfRoot =
      !this.tree || !this.rootNode || !this.workspaceRootPath || !isPathInside(absPath, this.workspaceRootPath);
    if (outOfRoot) {
      this.setRoot(absPath);
      // After re-root, the new rootNode IS the target. Reveal + select +
      // focus so the user lands inside the folder they asked for.
      if (this.tree && this.rootNode) {
        if (!focusNoScroll) {
          this.tree.revealElement(this.rootNode, revealRelativeTop);
        }
        this.tree.setSelection(this.rootNode);
        this.tree.domFocus();
        // Auto-expand the new root so its children are visible immediately —
        // matches the "I'm here now" expectation from a `cd` workflow.
        if (!this.tree.isExpanded(this.rootNode)) {
          this.tree.expand(this.rootNode);
        }
      }
      return;
    }

    // Path is inside current root — walk segments and expand ancestors.
    // The `outOfRoot` guard above proved all three are non-null; assertions
    // hold for the type-checker.
    const root = this.rootNode as FileNode;
    const rootPath = this.workspaceRootPath as string;
    const rel = absPath.slice(rootPath.length).replace(/^[\\/]+/, "");
    const segments = rel.length === 0 ? [] : rel.split(/[\\/]+/);

    let current: FileNode = root;
    for (const segment of segments) {
      if (current.kind !== "directory") {
        break;
      }
      if (!this.tree?.isExpanded(current)) {
        this.tree?.expand(current);
      }
      const children = (await this.tree?.getOrLoadChildren(current)) ?? [];
      if (this.disposed) {
        return;
      }
      const next = children.find((c) => c.name === segment);
      if (!next) {
        break;
      }
      current = next;
    }
    if (!focusNoScroll) {
      this.tree?.revealElement(current, revealRelativeTop);
    }
    this.tree?.setSelection(current);
    this.tree?.domFocus();
  }

  /**
   * Replace the tree's root with `absPath`. Tears down the current tree +
   * data source + sash + resize observer and re-mounts a fresh tree rooted
   * at the new path. Identity-keyed node cache is reset so stale references
   * from the previous root can be GC'd.
   *
   * Used by `revealPath` when the requested path is outside the current
   * root (e.g. the shell `cd`'d to a folder outside the workspace). The
   * workspace folder reported by VS Code is unchanged — this only affects
   * what the file-tree widget renders.
   */
  setRoot(absPath: string): void {
    if (this.disposed) {
      return;
    }
    // "recreate" strategy: the workspace root is unchanged from VS Code's
    // perspective but the file-tree wants to look elsewhere — we throw away
    // the data source so its pending map and identity cache are aligned
    // with the new root. `rootGeneration` MUST be the live value (kept in
    // sync by `handleRootChanged`) — not the constructor-time pin — so the
    // fresh data source is pinned to the host's current generation. Using
    // `deps.rootGeneration` here was a real bug: after a workspace-folder
    // change, every read on the new tree returned STALE_ROOT silently.
    this.remount({
      rootPath: absPath,
      dataSourceStrategy: "recreate",
      rootGeneration: this.currentRootGeneration,
    });
  }

  handleActivate(node: FileNode): void {
    if (this.disposed || isSyntheticSearchRow(node)) {
      return;
    }
    if (node.kind === "directory") {
      this.toggleDirectory(node);
      return;
    }
    // File row — post OpenFileMessage with the currently-active pane's sessionId.
    const sessionId = this.deps.getActiveSessionId();
    if (!sessionId) {
      // No active terminal — silently drop. The host's `openFile` handler
      // requires a sessionId, so a null-sessionId post would be rejected anyway.
      return;
    }
    const msg: OpenFileMessage = {
      type: "openFile",
      path: node.path,
      sessionId,
    };
    this.deps.postMessage(msg);
  }

  /**
   * Push fresh layout dimensions down to the underlying List widget. The
   * caller (e.g. `ResizeCoordinator`) invokes this after any size change. In
   * JSDOM tests, this is also the trigger that makes the virtualiser
   * materialise rows. Empty-state panels are a no-op.
   */
  layout(width: number, height: number): void {
    this.tree?.layout(height, width);
  }

  /**
   * Move the panel to one of four positions. Toggles the matching
   * `file-tree--{top|bottom|left|right}` class on the layoutWrapper. CSS does
   * the rest (flex direction + child order, see fileTreePanel.css). After
   * applying, triggers `onLayoutChange` so the caller (xterm fit) can
   * re-measure.
   */
  setPosition(position: FileTreePosition): void {
    if (this.disposed) {
      return;
    }
    const previous = this.currentPosition;
    this.currentPosition = position;
    this.applyPositionClass();
    // Position flips between horizontal/vertical re-orient the sash and the
    // axis the size is measured along. Recreate the sash on the new edge and
    // re-clamp the persisted size against the new layout's bounds.
    this.recreateSash();
    if (previous !== position) {
      this.applySize(this.currentSize);
    }
    this.persistCurrentState();
    this.deps.onLayoutChange?.();
  }

  /** Current position — useful for persisting in WebviewState. */
  getPosition(): FileTreePosition {
    return this.currentPosition;
  }

  /**
   * Show or hide the panel. Toggling does NOT destroy the Tree — `setOpen(true)`
   * later re-shows the same instance. Use `dispose()` for full teardown.
   *
   * The DOM class is ALWAYS synced even when `open` matches the current
   * value, because the constructor inherits `this.open` from persisted
   * state before `main.ts` calls `setOpen(persisted.open)` — a same-value
   * early-return would leave the HTML's default `file-tree--closed` class
   * stranded out of sync with the in-memory state. Persist + layout-fit
   * side effects still only fire on actual changes.
   */
  setOpen(open: boolean): void {
    if (this.disposed) {
      return;
    }
    const changed = this.open !== open;
    this.open = open;
    const wrapper = this.deps.layoutWrapper;
    if (wrapper) {
      wrapper.classList.toggle("file-tree--closed", !open);
    }
    if (changed) {
      this.persistCurrentState();
      this.deps.onLayoutChange?.();
    }
  }

  /** True if the panel is currently shown. */
  isOpen(): boolean {
    return this.open;
  }

  /**
   * Adopt a new workspace root (or null) and rotate to the new
   * `rootGeneration`. Drops in-flight RPC, clears in-memory tree state, and
   * re-mounts the Tree (or swaps to empty-state). Called by the webview
   * MessageRouter on `workspace-root-changed`. See design D10.
   */
  handleRootChanged(msg: { rootPath: string | null; rootGeneration: number }): void {
    if (this.disposed) {
      return;
    }
    // Track the live generation so a subsequent out-of-root reveal (which
    // routes via `setRoot` → recreate) can pin its fresh data source to the
    // right value. Forgetting this was the original "tree silently empty
    // after workspace-folder change + reveal" bug.
    this.currentRootGeneration = msg.rootGeneration;
    // Bubble the change into the search controller (cache invalidation).
    this.searchController?.onWorkspaceRootChanged();
    if (this.searchActive) {
      // Exit search-active mode so the user lands on the new workspace's
      // tree view rather than a stale search bar tied to the old scope.
      this.exitSearch();
    }
    // "rotate" strategy: the data source keeps its instance (which already
    // pinned the new generation via its own `handleRootChanged`) so any
    // in-flight RPC can be cancelled without leaking the cache structure.
    this.remount({
      rootPath: msg.rootPath,
      dataSourceStrategy: "rotate",
      rotateMsg: msg,
    });
  }

  /**
   * Shared teardown + re-mount used by `setRoot` and `handleRootChanged`.
   * The two callers differ in:
   *   - whether the data source is recreated (full reset) or rotated
   *     (keeps the instance but pins a new generation), and
   *   - the override generation passed to the new tree mount.
   *
   * Everything else (drag detach, resize observer disconnect, sash dispose,
   * tree dispose, body clear, mount-tree-or-empty-state, position class,
   * size variable, sash recreate, layout-change fire) is identical.
   */
  private remount(args: {
    rootPath: string | null;
    dataSourceStrategy: "recreate" | "rotate";
    /** Used by the rotate path to forward the new generation to the data source. */
    rotateMsg?: { rootPath: string | null; rootGeneration: number };
    /**
     * Generation to pin on the freshly-mounted tree's data source. Used by
     * the recreate path to seed the new source with the LIVE generation
     * (rotate path uses `rotateMsg.rootGeneration` instead — the data source
     * was rotated, not recreated).
     */
    rootGeneration?: number;
  }): void {
    // Tear down listeners + widgets bound to the previous mount.
    this.dragoverDetach?.();
    this.dragoverDetach = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.sash?.dispose();
    this.sash = null;
    // Exit + drop the search controller BEFORE disposing the tree —
    // the controller holds a `tree` reference captured at construction
    // time, so leaving it cached would mean the next `enterSearch` posts
    // results into a disposed tree (silent failure).
    if (this.searchActive) {
      this.exitSearch();
    }
    this.searchController = null;
    if (this.tree) {
      this.tree.dispose();
      this.tree = null;
    }

    // Data source: recreate vs rotate.
    if (args.dataSourceStrategy === "recreate") {
      if (this.dataSource) {
        this.dataSource.dispose();
        this.dataSource = null;
      }
    } else if (args.rotateMsg && this.dataSource) {
      this.dataSource.handleRootChanged(args.rotateMsg);
      // Keep the data source instance — it has the new generation pinned.
    }

    // Drop the existing DOM. Only clear the body — keep the header strip
    // (move button) intact across re-root. Falls back to whole-host clear
    // if the body wasn't created (legacy test paths bypassing the
    // constructor's header/body setup).
    if (this.bodyEl) {
      this.bodyEl.replaceChildren();
    } else {
      this.deps.host.replaceChildren();
    }
    this.emptyStateEl = null;
    this.expandedPaths.clear();
    this.rootNode = null;
    this.workspaceRootPath = null;

    // Mount the new root (or empty state for `rootPath === null`).
    if (args.rootPath === null) {
      this.mountEmptyState();
      // No root → clear the header's root row (name + chevron).
      this.syncHeaderRoot();
    } else {
      // Generation precedence: rotate path uses the message's gen (came from
      // the host), recreate path uses the explicit override (the panel's
      // currentRootGeneration). Falling back to deps would re-introduce
      // the stale-gen bug, so we deliberately don't.
      const gen = args.rotateMsg?.rootGeneration ?? args.rootGeneration ?? this.currentRootGeneration;
      this.mountTree(args.rootPath, gen);
    }

    // Re-apply position + size — the layoutWrapper survives across re-mounts;
    // only the panel's own DOM was replaced. Sash recreated on the new edge.
    this.applyPositionClass();
    this.applySize(this.currentSize);
    this.recreateSash();
    this.deps.onLayoutChange?.();
  }

  /**
   * Forward `read-directory-response` to the underlying data source.
   * Exposed so `main.ts` can route messages without holding a private ref
   * to the data source.
   */
  handleReadDirectoryResponse(msg: ReadDirectoryResponseMessage): void {
    this.dataSource?.handleResponse(msg);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.searchActive) {
      this.exitSearch();
    }
    this.searchController = null;
    this.disposed = true;
    this.dragoverDetach?.();
    this.dragoverDetach = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.sash?.dispose();
    this.sash = null;
    this.tree?.dispose();
    this.dataSource?.dispose();
    if (this.emptyStateEl?.parentElement) {
      this.emptyStateEl.parentElement.removeChild(this.emptyStateEl);
    }
    this.expandedPaths.clear();
  }

  // ─── internals ────────────────────────────────────────────────────

  private mountHeader(): void {
    const doc = this.deps.host.ownerDocument;
    const header = doc.createElement("div");
    header.className = "file-tree-header";

    // ─── Root row (left side) ─────────────────────────────────────────
    // Chevron + folder name. The Tree is configured with `hideRoot: true`
    // so the root never appears in the body — we own its representation
    // here. Clicking the row toggles the root's expand state in Tree.
    const rootRow = doc.createElement("div");
    rootRow.className = "file-tree-header__root";
    rootRow.setAttribute("role", "button");
    rootRow.setAttribute("tabindex", "0");
    rootRow.setAttribute("aria-label", "Toggle root folder");
    rootRow.setAttribute("aria-expanded", "false");

    const chevron = doc.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");

    const name = doc.createElement("span");
    name.className = "name";
    name.textContent = "";

    rootRow.appendChild(chevron);
    rootRow.appendChild(name);

    const toggleRoot = () => {
      if (!this.tree || !this.rootNode) {
        return;
      }
      if (this.tree.isExpanded(this.rootNode)) {
        this.tree.collapse(this.rootNode);
      } else {
        this.tree.expand(this.rootNode);
      }
    };
    rootRow.addEventListener("click", toggleRoot);
    rootRow.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggleRoot();
      }
    });

    // ─── Actions cluster (right side) ─────────────────────────────────
    const actions = doc.createElement("div");
    actions.className = "file-tree-header__actions";

    // Inline SVG provenance: microsoft/vscode codicon set (search / close /
    // layout). Glyph paths copied verbatim for CSP compliance.
    const searchBtn = makeHeaderButton(doc, {
      label: "Search files",
      svg: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>`,
      onClick: () => this.toggleSearch(),
    });
    this.headerSearchBtnEl = searchBtn;

    const closeBtn = makeHeaderButton(doc, {
      label: "Close File Tree",
      svg: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`,
      onClick: () => this.setOpen(false),
    });

    const moveBtn = makeHeaderButton(doc, {
      label: "Move File Tree",
      title: "Move File Tree…",
      svg: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="0.5"/><line x1="6" y1="1.5" x2="6" y2="14.5"/></svg>`,
      onClick: () => this.deps.postMessage({ type: "request-set-file-tree-position" }),
    });

    // Order: search → move → close. Close sits at the far right (matches
    // VS Code panel chrome where the "X" is always the outermost action).
    actions.appendChild(searchBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(closeBtn);

    header.appendChild(rootRow);

    // ─── Search bar (created up-front, hidden until enterSearch) ─────
    // Mounted as a sibling of the root row so the DOM swap is just a
    // visibility toggle, not a re-attach. Sits BEFORE the actions cluster.
    const searchBar = doc.createElement("div");
    searchBar.className = "file-tree-search-bar";
    searchBar.style.display = "none";

    const input = doc.createElement("input");
    input.type = "text";
    input.className = "file-tree-search-input";
    input.setAttribute("aria-label", "Search files");
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    searchBar.appendChild(input);

    const modeToggle = doc.createElement("div");
    modeToggle.className = "file-tree-search-mode-toggle";
    modeToggle.setAttribute("role", "group");
    modeToggle.setAttribute("aria-label", "Search mode");

    const filterBtn = doc.createElement("button");
    filterBtn.type = "button";
    filterBtn.className = "file-tree-search-mode-toggle__btn";
    filterBtn.textContent = "Filter";
    filterBtn.title = "Filter — show only matching files";
    filterBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.setSearchMode("filter");
      input.focus();
    });

    const highlightBtn = doc.createElement("button");
    highlightBtn.type = "button";
    highlightBtn.className = "file-tree-search-mode-toggle__btn";
    highlightBtn.textContent = "Highlight";
    highlightBtn.title = "Highlight — show all files, matches highlighted";
    highlightBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.setSearchMode("highlight");
      input.focus();
    });

    modeToggle.appendChild(filterBtn);
    modeToggle.appendChild(highlightBtn);
    searchBar.appendChild(modeToggle);

    header.appendChild(searchBar);
    header.appendChild(actions);

    this.deps.host.appendChild(header);
    this.headerRootRowEl = rootRow;
    this.headerRootNameEl = name;
    this.searchBarEl = searchBar;
    this.searchInputEl = input;
    this.searchModeFilterBtn = filterBtn;
    this.searchModeHighlightBtn = highlightBtn;
  }

  /**
   * Toggle the panel between idle and search-active modes. Real DOM swap
   * (root row → search bar) is mounted in 4_3 via `enterSearch()` /
   * `exitSearch()`. This stub keeps the click handler bound during 4_2
   * so the button is interactive from the moment it appears.
   */
  private toggleSearch(): void {
    if (this.searchActive) {
      this.exitSearch();
    } else {
      this.enterSearch();
    }
  }

  /**
   * Resolve the search scope for THIS search session.
   *
   * If the current Tree selection is a folder, the scope is its absolute
   * path; otherwise the scope is the workspace root (or the current tree
   * root when the workspace root is null, e.g. user navigated out via OSC 7).
   * Captured once at entry and held constant for the duration of the session.
   *
   * See: asimov/changes/add-file-tree-search/design.md D2.
   */
  private resolveSearchScope(): string | null {
    const selected = this.tree?.getSelection();
    if (selected && selected.kind === "directory") {
      return selected.path;
    }
    return this.workspaceRootPath ?? this.rootNode?.path ?? null;
  }

  /** Update the placeholder + button-pressed state to reflect current mode/scope. */
  private syncSearchBarUI(scope: string | null): void {
    if (!this.searchInputEl || !this.searchModeFilterBtn || !this.searchModeHighlightBtn) {
      return;
    }
    const folderName = scope ? scope.split(/[\\/]/).pop() : null;
    this.searchInputEl.placeholder =
      folderName && scope !== this.workspaceRootPath ? `Search in ${folderName}` : "Search files";
    const mode = this.readPersistedSearchMode();
    this.searchModeFilterBtn.classList.toggle("is-active", mode === "filter");
    this.searchModeFilterBtn.setAttribute("aria-pressed", mode === "filter" ? "true" : "false");
    this.searchModeHighlightBtn.classList.toggle("is-active", mode === "highlight");
    this.searchModeHighlightBtn.setAttribute("aria-pressed", mode === "highlight" ? "true" : "false");
  }

  /** Read `FileTreeState.searchMode` via the persisted-state callback; default 'filter'. */
  private readPersistedSearchMode(): SearchMode {
    const persisted = this.deps.getPersistedState?.();
    return persisted?.searchMode ?? "filter";
  }

  /** Write back the searchMode preference (only field of search state we persist). */
  private writePersistedSearchMode(mode: SearchMode): void {
    const persisted = this.deps.getPersistedState?.();
    if (!persisted) {
      return;
    }
    this.deps.persistState?.({ ...persisted, searchMode: mode });
  }

  /** Click handler for the Filter/Highlight toggle. */
  private setSearchMode(mode: SearchMode): void {
    this.writePersistedSearchMode(mode);
    this.syncSearchBarUI(this.currentSearchScope);
    this.searchController?.setMode(mode);
  }

  /**
   * Lazily construct the search controller. Idempotent — returns the cached
   * instance after the first call.
   */
  private getOrCreateSearchController(): FileTreeSearchController | null {
    if (this.searchController) {
      return this.searchController;
    }
    if (!this.tree) {
      return null;
    }
    this.searchController = new FileTreeSearchController({
      tree: this.tree,
      post: (m) => this.deps.postMessage(m),
      getRootGeneration: () => this.currentRootGeneration,
    });
    return this.searchController;
  }

  /**
   * Enter search-active mode: hide the root row, show the search bar, focus
   * the input on the same tick, capture the scope, and start the controller.
   */
  private enterSearch(): void {
    if (this.searchActive || !this.tree) {
      return;
    }
    const controller = this.getOrCreateSearchController();
    if (!controller) {
      return;
    }
    const scope = this.resolveSearchScope();
    if (!scope) {
      return;
    }
    this.searchActive = true;
    this.currentSearchScope = scope;

    if (this.headerRootRowEl) {
      this.headerRootRowEl.style.display = "none";
    }
    if (this.searchBarEl) {
      this.searchBarEl.style.display = "";
    }
    if (this.headerSearchBtnEl) {
      this.headerSearchBtnEl.setAttribute("aria-label", "Close search");
      this.headerSearchBtnEl.setAttribute("title", "Close search");
    }
    if (this.searchInputEl) {
      this.searchInputEl.value = "";
      this.syncSearchBarUI(scope);
      this.searchInputEl.focus();
      // Wire input handlers — re-attach each entry so listener identity
      // stays trivial (no add/remove pair across sessions).
      this.searchInputEl.oninput = () => {
        controller.setQuery(this.searchInputEl?.value ?? "");
      };
      this.searchInputEl.onkeydown = (ev) => this.onSearchKeyDown(ev);
    }
    controller.enter(scope, this.readPersistedSearchMode());
  }

  /** Exit search-active mode: restore the tree, drop the controller state. */
  private exitSearch(): void {
    if (!this.searchActive) {
      return;
    }
    this.searchActive = false;
    this.currentSearchScope = null;
    if (this.searchInputEl) {
      this.searchInputEl.oninput = null;
      this.searchInputEl.onkeydown = null;
      this.searchInputEl.value = "";
    }
    if (this.searchBarEl) {
      this.searchBarEl.style.display = "none";
    }
    if (this.headerRootRowEl) {
      this.headerRootRowEl.style.display = "";
    }
    if (this.headerSearchBtnEl) {
      this.headerSearchBtnEl.setAttribute("aria-label", "Search files");
      this.headerSearchBtnEl.setAttribute("title", "Search files");
    }
    this.searchController?.exit();
  }

  /** Keyboard handler attached to the search input. */
  private onSearchKeyDown(ev: KeyboardEvent): void {
    if (!this.tree) {
      return;
    }
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        this.tree.focusNext();
        return;
      case "ArrowUp":
        ev.preventDefault();
        this.tree.focusPrevious();
        return;
      case "Enter": {
        ev.preventDefault();
        const focused = this.tree.getFocused();
        if (!focused) {
          return;
        }
        // Route through the same activation path normal clicks use — keeps
        // the no-active-session drop behavior consistent and skips synthetic
        // rows via the guard inside handleActivate().
        this.handleActivate(focused);
        return;
      }
      case "Escape":
        ev.preventDefault();
        this.exitSearch();
        return;
      default:
        return;
    }
  }

  /** Public hook so the controller-message router can deliver responses. */
  public handleSearchResponse(msg: FileTreeSearchResponseMessage): void {
    this.searchController?.onResponse(msg);
  }

  /**
   * Re-stamp the header's root row to reflect the current root + expansion
   * state. Called after the root is (re)mounted and after every expand /
   * collapse event involving the root.
   */
  private syncHeaderRoot(): void {
    if (!this.headerRootRowEl || !this.headerRootNameEl) {
      return;
    }
    if (!this.rootNode) {
      this.headerRootNameEl.textContent = "";
      this.headerRootRowEl.setAttribute("aria-expanded", "false");
      return;
    }
    this.headerRootNameEl.textContent = this.rootNode.name;
    const expanded = this.tree?.isExpanded(this.rootNode) ?? false;
    this.headerRootRowEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  private mountBody(): void {
    const body = this.deps.host.ownerDocument.createElement("div");
    body.className = "file-tree-body";
    this.deps.host.appendChild(body);
    this.bodyEl = body;
  }

  private mountEmptyState(): void {
    const el = this.deps.host.ownerDocument.createElement("div");
    el.className = EMPTY_STATE_CLASS;
    el.textContent = EMPTY_STATE_TEXT;
    (this.bodyEl ?? this.deps.host).appendChild(el);
    this.emptyStateEl = el;
  }

  private mountTree(workspaceRoot: string, overrideRootGeneration?: number): void {
    const gen = overrideRootGeneration ?? this.deps.rootGeneration;
    // Re-use existing data source if we have one (handleRootChanged already
    // pinned the new generation onto it). Otherwise construct fresh.
    if (!this.dataSource) {
      this.dataSource = new FileSystemDataSource({ rootGeneration: gen, workspaceRoot }, (m) =>
        this.deps.postMessage(m),
      );
    }

    const renderer = new ReadOnlyFileRenderer();
    // Tree mounts inside the dedicated body — keeps the toolbar header above
    // the list and untouched by Tree's internal DOM management.
    //
    // `hideRoot: true` skips rendering the workspace-root row in the list;
    // we surface the root inside `.file-tree-header` (chevron + name)
    // instead, with close + move buttons on the right.
    const treeHost = this.bodyEl ?? this.deps.host;
    this.tree = new Tree<FileNode>(treeHost, this.dataSource, renderer, { hideRoot: true });

    this.tree.onDidActivate((node) => this.handleActivate(node));
    this.tree.onDidChangeExpansion((e) => {
      if (e.expanded) {
        this.expandedPaths.add(e.element.path);
      } else {
        this.expandedPaths.delete(e.element.path);
      }
      this.persistCurrentState();
      // The root's chevron lives in the header — re-stamp it whenever any
      // expansion event names the root.
      if (this.rootNode && e.element === this.rootNode) {
        this.syncHeaderRoot();
      }
    });

    // Reject any drop inside the file-tree container — we only allow drag-OUT
    // (drop into a terminal pane). See design D11 + task 5_2.
    const onDragOver = (ev: DragEvent): void => {
      if (ev.dataTransfer?.types.includes(FILE_TREE_DRAG_MIME)) {
        ev.dataTransfer.dropEffect = "none";
        ev.preventDefault();
      }
    };
    const dropTarget = this.bodyEl ?? this.deps.host;
    dropTarget.addEventListener("dragover", onDragOver);
    this.dragoverDetach = () => dropTarget.removeEventListener("dragover", onDragOver);

    const rootNode: FileNode = {
      name: basename(workspaceRoot),
      path: workspaceRoot,
      kind: "directory",
    };
    this.tree.setInput(rootNode);
    this.expandedPaths.add(workspaceRoot);
    this.rootNode = rootNode;
    this.workspaceRootPath = workspaceRoot;
    // Header surfaces the root row (chevron + name); sync now that rootNode
    // is pinned. The expanded-state attr reflects what Tree.setInput just
    // stamped (`{ expanded: true }`).
    this.syncHeaderRoot();

    // Bridge host dimensions into the underlying List widget. ResizeObserver
    // fires once synchronously on `observe()` (covering initial mount) and
    // then on every host resize, including the display:none↔flex flip from
    // `.file-tree--closed`. Zero-sized entries are skipped because layout(0,0)
    // would tear down virtualisation state we want to retain across hide/show.
    this.installResizeObserver();
  }

  private installResizeObserver(): void {
    const view = this.deps.host.ownerDocument?.defaultView;
    if (!view?.ResizeObserver) {
      return;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = new view.ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === 0 || height === 0) {
          continue;
        }
        this.tree?.layout(height, width);
      }
    });
    // Observe the body (where the Tree mounts) — not the whole panel — so
    // `layout(width, height)` reflects the viewport AFTER subtracting the
    // header strip. Observing the panel would report a height that includes
    // the header, making the last row appear cropped.
    this.resizeObserver.observe(this.bodyEl ?? this.deps.host);
  }

  private applyPositionClass(): void {
    const wrapper = this.deps.layoutWrapper;
    if (!wrapper) {
      return;
    }
    for (const p of POSITIONS) {
      wrapper.classList.remove(`${POSITION_CLASS_PREFIX}${p}`);
    }
    wrapper.classList.add(`${POSITION_CLASS_PREFIX}${this.currentPosition}`);
  }

  private persistCurrentState(): void {
    if (!this.deps.persistState) {
      return;
    }
    // Preserve fields owned by other writers (currently `searchMode`,
    // written via writePersistedSearchMode) — without this read-merge a
    // routine expand/collapse/setOpen/setPosition would clobber the
    // user's saved search-mode preference.
    const existing = this.deps.getPersistedState?.();
    this.deps.persistState({
      ...(existing ?? {}),
      open: this.open,
      position: this.currentPosition,
      expandedPaths: Array.from(this.expandedPaths),
      size: this.currentSize,
    });
  }

  // ─── Sash (resize boundary) ───────────────────────────────────────

  /**
   * Clamp `next` to `[MIN_SIZE, 85% of layout dimension]` then push it onto
   * the layout wrapper as `--file-tree-size`. Called from the sash drag
   * handler on every pointer move and once from the constructor / position
   * change to apply the persisted value.
   */
  private applySize(next: number): void {
    const wrapper = this.deps.layoutWrapper;
    const horizontal = isHorizontalLayout(this.currentPosition);
    const dim = wrapper ? (horizontal ? wrapper.clientWidth : wrapper.clientHeight) : 0;
    // When the wrapper isn't measurable yet (first paint), skip the upper
    // clamp — the size will get re-clamped on the next setPosition/drag once
    // dimensions are known.
    const maxSize = dim > 0 ? Math.max(MIN_SIZE + 80, dim * 0.85) : Number.POSITIVE_INFINITY;
    const clamped = Math.max(MIN_SIZE, Math.min(maxSize, next));
    this.currentSize = clamped;
    if (wrapper) {
      wrapper.style.setProperty("--file-tree-size", `${clamped}px`);
    }
  }

  /**
   * Tear down any existing sash DOM + listeners and recreate one on the
   * current edge. Delegated to `FileTreeSash`. Called whenever position
   * flips between horizontal and vertical (so the sash sits on the right
   * side of the panel) and after re-mounting on a workspace root change.
   */
  private recreateSash(): void {
    if (this.disposed) {
      this.sash?.dispose();
      this.sash = null;
      return;
    }
    if (!this.sash) {
      this.sash = new FileTreeSash({
        host: this.deps.host,
        getPosition: () => this.currentPosition,
        getStartSize: () => this.currentSize,
        applySize: (next) => this.applySize(next),
        onCommit: () => {
          this.persistCurrentState();
          this.deps.onLayoutChange?.();
        },
      });
    }
    this.sash.recreate();
  }

  private toggleDirectory(node: FileNode): void {
    if (!this.tree) {
      return;
    }
    // Consult the Tree's actual expansion state — `expandedPaths` is the
    // persisted-state mirror, which can be out of sync with the live tree
    // when persisted paths haven't yet been re-applied on mount. Using
    // `expandedPaths` here caused a stuck-folder bug where the first click
    // on a persisted-expanded folder would call `collapse` (which Tree
    // no-ops because the node isn't actually expanded), trapping the row
    // in a permanently-closed state.
    if (this.tree.isExpanded(node)) {
      this.tree.collapse(node);
    } else {
      this.tree.expand(node);
    }
  }
}

/** POSIX-and-Windows-safe basename without pulling `node:path` into the webview bundle. */
function basename(p: string): string {
  const lastSlash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (lastSlash === -1) {
    return p;
  }
  return p.slice(lastSlash + 1) || p;
}

/**
 * Containment check that's safe across `repo` / `repo2` siblings (a naive
 * `startsWith(root)` matches `/work/repo2/x` against `/work/repo`). Treats
 * `root === absPath` as containment and accepts either path separator.
 */
function isPathInside(absPath: string, root: string): boolean {
  if (absPath === root) {
    return true;
  }
  return absPath.startsWith(`${root}/`) || absPath.startsWith(`${root}\\`);
}

/**
 * Build one of the header action buttons. Shared shape: 14×14 icon, single
 * SVG payload, click handler with preventDefault + stopPropagation so the
 * click doesn't bubble into the root-row toggle behind it.
 */
function makeHeaderButton(
  doc: Document,
  opts: { label: string; svg: string; onClick: () => void; title?: string },
): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "file-tree-header__btn";
  btn.title = opts.title ?? opts.label;
  btn.setAttribute("aria-label", opts.label);
  btn.innerHTML = opts.svg;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    opts.onClick();
  });
  return btn;
}
