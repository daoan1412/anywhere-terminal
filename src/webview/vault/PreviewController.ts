// Orchestrates the floating session-preview overlay: open/close lifecycle,
// detail pagination (load-more + scroll-to-first), nested subagent/teammate
// lazy-loading, the document close-listeners, and header tooltip disposal.
// Mediates between FloatingWindow (window chrome), PreviewScrollNav (FABs), and
// the pure previewTimeline renderers — it is the single owner of preview state.
//
// Security: every host message carries `entryId` only (D9); untrusted strings go
// through textContent; the only innerHTML lives in the closed-map icon builders.

import type { VaultSessionDetailResponseMessage } from "../../types/messages";
import type { VaultSessionDetail, VaultSessionEntry } from "../../vault/types";
import type { VaultPreviewGeometry } from "../state/WebviewState";
import { getAgentAccent, VAULT_ACCENTS } from "./agentIcons";
import { FloatingWindow } from "./FloatingWindow";
import { buildPreviewHeader as buildPreviewHeaderDom } from "./previewHeader";
import { PreviewScrollNav } from "./previewScrollNav";
import { type PreviewTimelineBag, renderNestedInto, renderTimelineInto } from "./previewTimeline";
import { loadingBody } from "./renderAtoms";
import type { VaultPanelPostMessage } from "./VaultPanel";

/** Timeline items requested on the first open, and the step added per load-more. */
const PREVIEW_LIMIT_DEFAULT = 400;
const PREVIEW_LIMIT_STEP = 400;

export interface PreviewControllerDeps {
  postMessage: VaultPanelPostMessage;
  /** Whether the row context menu is open (Esc layering — one Esc shouldn't close both). */
  isContextMenuOpen: () => boolean;
  /** Close the context menu when a preview opens. */
  closeContextMenu: () => void;
  /** Live-resolve the list row for the open preview's entryId (anchoring). The
   *  controller stores no row ref — VaultPanel owns the list DOM (no rebind seam). */
  getActiveRow: () => HTMLElement | null;
  /** Ask VaultPanel to re-apply the selection highlight from `activeEntryId`
   *  (called after open/close, since an internal close has no VaultPanel call). */
  syncHighlight: () => void;
  getInitialPreviewGeometry?: () => VaultPreviewGeometry | null;
  persistPreviewGeometry?: (geometry: VaultPreviewGeometry) => void;
}

export class PreviewController {
  /** Floating session-preview overlay element (at most one open). */
  private readonly previewEl: HTMLElement;
  private readonly deps: PreviewControllerDeps;
  private readonly floatingWindow: FloatingWindow;
  private readonly scrollNav: PreviewScrollNav;
  private readonly timelineBag: PreviewTimelineBag;

  /** The entry id whose detail the open preview is for — stale responses (≠ this) are dropped. */
  private activePreviewEntryId: string | null = null;
  private activePreviewEntry: VaultSessionEntry | null = null;
  /** The detail currently shown — kept so "show more" can re-render in place. */
  private activePreviewDetail: VaultSessionDetail | null = null;
  /** Keys (`<prefix>#<runIndex>`) of AI-runs expanded past the per-run cap. */
  private readonly expandedRuns = new Set<string>();
  /** Dispose fns for the preview header's custom tooltips (rebuilt every render). */
  private readonly previewTooltipDisposers: Array<() => void> = [];
  /** Timeline-item limit for the open preview (grows when older msgs are loaded). */
  private previewLimit = PREVIEW_LIMIT_DEFAULT;
  /** True while a load-more request is in flight (debounces the scroll trigger). */
  private previewLoadingMore = false;
  /** Set while a "scroll to first message" gesture loads every older window. */
  private previewScrollToTopPending = false;
  /** Timeline length seen on the previous load-all step (terminates the loop when a
   *  capped, still-`truncated` response stops growing). */
  private previewScrollToTopLastCount = 0;
  /** Nested subagent expansion state, keyed by child entryId (survives re-renders);
   *  `nestedDetails` caches fetched child transcripts; `pendingNested` routes an
   *  in-flight detail response to its block. All reset when the preview closes. */
  private readonly expandedNested = new Set<string>();
  private readonly nestedDetails = new Map<string, VaultSessionDetail>();
  /** Child entryId → every open block awaiting that detail. A Set (not one element)
   *  so two blocks sharing a child entryId both resolve from a single response. */
  private readonly pendingNested = new Map<string, Set<HTMLElement>>();
  /** Child entryIds whose cached detail is mid-render — breaks a self-referential
   *  cycle (a child that nests its own id) before it overflows the stack. */
  private readonly renderingNested = new Set<string>();
  private onPreviewDocPointerDown?: (ev: MouseEvent) => void;
  private onPreviewDocKeyDown?: (ev: KeyboardEvent) => void;

  constructor(deps: PreviewControllerDeps) {
    this.deps = deps;
    this.previewEl = document.createElement("aside");
    this.previewEl.className = "vault-preview";
    this.previewEl.setAttribute("aria-label", "Session preview");
    this.floatingWindow = new FloatingWindow({
      el: this.previewEl,
      initialGeometry: deps.getInitialPreviewGeometry?.() ?? null,
      persistGeometry: deps.persistPreviewGeometry,
      getAnchorRow: deps.getActiveRow,
    });
    this.scrollNav = new PreviewScrollNav({
      el: this.previewEl,
      onScrollTop: () => this.scrollPreviewToTop(),
    });
    this.timelineBag = {
      isRunExpanded: (key) => this.expandedRuns.has(key),
      onExpandRun: (key) => {
        this.expandedRuns.add(key);
        this.rerenderActiveDetail();
      },
      isNestedExpanded: (entryId) => this.expandedNested.has(entryId),
      setNestedExpanded: (entryId, expanded) => {
        if (expanded) {
          this.expandedNested.add(entryId);
        } else {
          // Collapse drops any in-flight nested request so a late response can't
          // populate the now-hidden body (R4 stale-guard).
          this.expandedNested.delete(entryId);
          this.pendingNested.delete(entryId);
        }
      },
      populateNested: (entryId, body) => this.populateNested(entryId, body),
    };
  }

  /** The overlay element — appended into the panel host by VaultPanel. */
  get element(): HTMLElement {
    return this.previewEl;
  }

  /** Entry id of the open preview (or null) — VaultPanel reads it to re-anchor selection. */
  get activeEntryId(): string | null {
    return this.activePreviewEntryId;
  }

  /** Keep the active entry reference live when a host push skips the DOM re-render. */
  refreshActiveEntry(entry: VaultSessionEntry): void {
    this.activePreviewEntry = entry;
  }

  /** Tear down all owned resources. Closing the preview detaches the document
   *  listeners, disposes header tooltips, cancels any in-flight drag, and resets
   *  the scroll-nav timer. Idempotent — safe when nothing is open. */
  dispose(): void {
    this.closePreview();
  }

  /**
   * Activate a row → open the floating preview in a loading state, anchor it near
   * the row, request the session detail. `activePreviewEntryId` is the guard the
   * response handler checks so a slow response for a row the user has left is dropped.
   */
  open(entry: VaultSessionEntry): void {
    this.deps.closeContextMenu();

    this.activePreviewEntryId = entry.id;
    this.activePreviewEntry = entry;
    this.activePreviewDetail = null;
    this.expandedRuns.clear();
    this.expandedNested.clear();
    this.nestedDetails.clear();
    this.pendingNested.clear();
    this.previewLimit = PREVIEW_LIMIT_DEFAULT;
    this.previewLoadingMore = false;
    this.previewScrollToTopPending = false;
    this.previewScrollToTopLastCount = 0;
    this.scrollNav.reset();

    this.applyPreviewAgentAccent(entry.agent);
    this.renderPreviewLoading(entry);
    this.previewEl.classList.add("is-open");
    this.deps.syncHighlight(); // VaultPanel sets aria-selected on the active row
    this.floatingWindow.place(); // anchors via getActiveRow (the just-clicked row)
    this.attachPreviewCloseListeners();
    this.deps.postMessage({ type: "requestVaultSessionDetail", entryId: entry.id });
  }

  /** Tint the preview's user messages with the session's agent accent (D: #3). */
  private applyPreviewAgentAccent(agent: string): void {
    for (const a of VAULT_ACCENTS) {
      this.previewEl.classList.remove(`vault-preview--${a}`);
    }
    // Only a known, closed accent may become a class — never a raw session-derived
    // agent string (W6 / the injection rule).
    const accent = getAgentAccent(agent);
    if (accent) {
      this.previewEl.classList.add(`vault-preview--${accent}`);
    }
  }

  private closePreview(): void {
    // Abort an in-flight drag first so its listeners don't outlive the closed
    // preview or overwrite the saved geometry on release (W5).
    this.floatingWindow.cancelGesture();
    this.previewEl.classList.remove("is-open");
    this.previewEl.replaceChildren();
    // FloatingWindow keeps geometry + maximized so the next open restores them (#1).
    this.activePreviewEntryId = null;
    this.activePreviewEntry = null;
    this.activePreviewDetail = null;
    this.expandedRuns.clear();
    this.expandedNested.clear();
    this.nestedDetails.clear();
    this.pendingNested.clear();
    this.previewScrollToTopPending = false;
    this.previewScrollToTopLastCount = 0;
    this.scrollNav.reset();
    this.deps.syncHighlight(); // clears aria-selected (activeEntryId is now null)
    this.disposePreviewTooltips();
    this.detachPreviewCloseListeners();
  }

  private disposePreviewTooltips(): void {
    for (const dispose of this.previewTooltipDisposers) {
      dispose();
    }
    this.previewTooltipDisposers.length = 0;
  }

  /** Render preview content, keeping the resize handles + scroll nav attached on top. */
  private setPreviewContent(...nodes: Node[]): void {
    this.previewEl.replaceChildren(...nodes, ...this.floatingWindow.resizeHandles, this.scrollNav.element);
    this.scrollNav.wire();
  }

  /** Scroll to the session's FIRST message; loads every older window first when
   *  the timeline is still truncated (driven by `previewScrollToTopPending` below). */
  private scrollPreviewToTop(): void {
    if (this.activePreviewDetail?.truncated) {
      this.previewScrollToTopPending = true;
      this.previewScrollToTopLastCount = this.activePreviewDetail.timeline?.length ?? 0;
      this.requestMorePreview();
      return;
    }
    this.scrollNav.scrollBody(0);
  }

  /**
   * Host → webview detail reply. Drops a response whose `entryId` is no longer the
   * active preview (stale-render guard). Renders the detail, a partial notice, or
   * an inline error; a nested reply routes to its expanded block independently.
   */
  handleSessionDetailResponse(msg: VaultSessionDetailResponseMessage): void {
    const nestedContainers = this.pendingNested.get(msg.entryId);
    if (nestedContainers) {
      this.pendingNested.delete(msg.entryId);
      if (msg.detail && !msg.error) {
        this.nestedDetails.set(msg.entryId, msg.detail);
        for (const container of nestedContainers) {
          renderNestedInto(container, msg.detail, msg.entryId, this.timelineBag);
        }
      } else {
        const text = msg.error ?? "Couldn't read this sub-session.";
        for (const container of nestedContainers) {
          container.textContent = text;
        }
      }
      return;
    }
    if (msg.entryId !== this.activePreviewEntryId || !this.activePreviewEntry) {
      return; // stale — ignore
    }
    const wasLoadingMore = this.previewLoadingMore;
    this.previewLoadingMore = false;
    if (msg.error || !msg.detail) {
      // Clear an in-flight "scroll to first message" walk — otherwise the flag
      // stays stale and the next successful reply jumps to the top unexpectedly.
      this.previewScrollToTopPending = false;
      this.previewScrollToTopLastCount = 0;
      this.renderPreviewError(this.activePreviewEntry, msg.error ?? "Couldn't read this session.");
      return;
    }
    // On load-more, older items are prepended → keep the viewport anchored to the
    // same content by preserving the distance from the bottom across the re-render.
    const bodyBefore = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    const fromBottom = wasLoadingMore && bodyBefore ? bodyBefore.scrollHeight - bodyBefore.scrollTop : null;
    // A load-more re-render prepends older items to the ROOT timeline, shifting its
    // run indices → drop root run-expansions only. Nested transcripts didn't change,
    // so their `<entryId>#…` expansions stay valid (must not be cleared).
    if (wasLoadingMore) {
      for (const k of this.expandedRuns) {
        if (k.startsWith("root#")) {
          this.expandedRuns.delete(k);
        }
      }
    }
    this.renderPreviewDetail(this.activePreviewEntry, msg.detail);
    if (this.previewScrollToTopPending) {
      // A "scroll to first message" gesture is walking older windows. Keep loading
      // while the timeline still GROWS; stop once fully loaded OR the host stops
      // returning more (it clamps at MAX_DETAIL_LIMIT, so a >cap session stays
      // `truncated` forever — without the growth check this would loop). Then jump
      // to the very top instantly (a smooth scroll across full history would be jarring).
      const count = this.activePreviewDetail?.timeline?.length ?? 0;
      const grew = count > this.previewScrollToTopLastCount;
      this.previewScrollToTopLastCount = count;
      if (this.activePreviewDetail?.truncated && grew) {
        this.requestMorePreview();
      } else {
        this.previewScrollToTopPending = false;
        this.previewScrollToTopLastCount = 0;
        const bodyAfter = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
        if (bodyAfter) {
          bodyAfter.scrollTop = 0;
        }
      }
    } else if (fromBottom !== null) {
      const bodyAfter = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
      if (bodyAfter) {
        bodyAfter.scrollTop = Math.max(0, bodyAfter.scrollHeight - fromBottom);
      }
    } else {
      // Initial open: jump to the latest message (bottom); scroll up for history (#1).
      this.scrollNav.scrollToEnd();
    }
  }

  private attachPreviewCloseListeners(): void {
    this.detachPreviewCloseListeners();
    this.onPreviewDocPointerDown = (e) => {
      const target = e.target as Node;
      // Don't close when the click is inside the preview or on a row (a row click
      // opens a different preview, handled by its own listener).
      if (this.previewEl.contains(target) || (target instanceof Element && target.closest(".vault-row"))) {
        return;
      }
      this.closePreview();
    };
    this.onPreviewDocKeyDown = (e) => {
      // When the context menu is also open, let its own Esc handler dismiss only
      // that layer first — one Esc shouldn't close both (W5).
      if (e.key === "Escape" && !this.deps.isContextMenuOpen()) {
        this.closePreview();
      }
    };
    document.addEventListener("mousedown", this.onPreviewDocPointerDown);
    document.addEventListener("keydown", this.onPreviewDocKeyDown);
  }

  private detachPreviewCloseListeners(): void {
    if (this.onPreviewDocPointerDown) {
      document.removeEventListener("mousedown", this.onPreviewDocPointerDown);
      this.onPreviewDocPointerDown = undefined;
    }
    if (this.onPreviewDocKeyDown) {
      document.removeEventListener("keydown", this.onPreviewDocKeyDown);
      this.onPreviewDocKeyDown = undefined;
    }
  }

  private buildPreviewHeader(entry: VaultSessionEntry, detail?: VaultSessionDetail): HTMLElement {
    // Tear down the prior build's tooltips before the new build attaches its own.
    this.disposePreviewTooltips();
    const { element, disposers } = buildPreviewHeaderDom(entry, detail, {
      isMaximized: () => this.floatingWindow.isMaximized(),
      onMovePointerDown: (ev) => this.floatingWindow.startMove(ev),
      onPrevUser: () => this.scrollNav.scrollToAdjacentUser(-1),
      onNextUser: () => this.scrollNav.scrollToAdjacentUser(1),
      onResume: () => this.deps.postMessage({ type: "vaultResume", entryId: entry.id }),
      onToggleMaximize: () => this.floatingWindow.toggleMaximize(),
      onClose: () => this.closePreview(),
    });
    this.previewTooltipDisposers.push(...disposers);
    return element;
  }

  private renderPreviewLoading(entry: VaultSessionEntry): void {
    this.setPreviewContent(this.buildPreviewHeader(entry), loadingBody());
  }

  private renderPreviewError(entry: VaultSessionEntry, message: string): void {
    const body = document.createElement("div");
    body.className = "vault-preview-error";
    body.textContent = message;
    this.setPreviewContent(this.buildPreviewHeader(entry), body);
  }

  private renderPreviewDetail(entry: VaultSessionEntry, detail: VaultSessionDetail): void {
    this.activePreviewDetail = detail; // kept so "Show more" can re-render in place
    const body = document.createElement("div");
    body.className = "vault-preview-body";

    if (detail.truncated) {
      const loadMore = document.createElement("button");
      loadMore.type = "button";
      loadMore.className = "vault-preview-loadmore";
      loadMore.title = "Load older messages in this session";
      loadMore.textContent = this.previewLoadingMore ? "Loading older messages…" : "↑ Load older messages";
      loadMore.disabled = this.previewLoadingMore;
      loadMore.addEventListener("click", () => this.requestMorePreview());
      body.appendChild(loadMore);
    }
    if (detail.partial && detail.limitedReason) {
      const notice = document.createElement("div");
      notice.className = "vault-preview-notice";
      notice.textContent = detail.limitedReason;
      body.appendChild(notice);
    }

    // Full chronological transcript, run-grouped + capped. The same renderer is
    // reused for nested transcripts so capping + pinned conclusions match (D14).
    renderTimelineInto(body, detail.timeline ?? [], "root", this.timelineBag);

    // Scroll to the top → load older messages (incremental, while more remain).
    body.addEventListener("scroll", () => {
      if (body.scrollTop <= 48 && this.activePreviewDetail?.truncated && !this.previewLoadingMore) {
        this.requestMorePreview();
      }
    });

    this.setPreviewContent(this.buildPreviewHeader(entry, detail), body);
  }

  /** Re-render the active detail in place, preserving scroll — used when expanding
   *  a run (renderPreviewDetail rebuilds from scratch, resetting scrollTop to 0). */
  private rerenderActiveDetail(): void {
    if (!this.activePreviewEntry || !this.activePreviewDetail) {
      return;
    }
    const prevScroll = this.previewEl.querySelector<HTMLElement>(".vault-preview-body")?.scrollTop ?? 0;
    this.renderPreviewDetail(this.activePreviewEntry, this.activePreviewDetail);
    const newBody = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    if (newBody) {
      newBody.scrollTop = prevScroll;
    }
  }

  /** Request the next-older window of timeline items (grows the limit). */
  private requestMorePreview(): void {
    if (this.previewLoadingMore || !this.activePreviewEntryId || !this.activePreviewDetail?.truncated) {
      return;
    }
    this.previewLoadingMore = true;
    this.previewLimit += PREVIEW_LIMIT_STEP;
    const btn = this.previewEl.querySelector<HTMLButtonElement>(".vault-preview-loadmore");
    if (btn) {
      btn.textContent = "Loading older messages…";
      btn.disabled = true;
    }
    this.deps.postMessage({
      type: "requestVaultSessionDetail",
      entryId: this.activePreviewEntryId,
      limit: this.previewLimit,
    });
  }

  /** Fill a subagent block's body: from cache, or lazily fetch the child detail. */
  private populateNested(entryId: string, body: HTMLElement): void {
    const cached = this.nestedDetails.get(entryId);
    if (cached) {
      // Cached render is synchronous; if this id is already on the render stack the
      // detail nests itself — stop rather than recurse into a stack overflow.
      if (this.renderingNested.has(entryId)) {
        body.replaceChildren();
        return;
      }
      this.renderingNested.add(entryId);
      try {
        renderNestedInto(body, cached, entryId, this.timelineBag);
      } finally {
        this.renderingNested.delete(entryId);
      }
      return;
    }
    body.replaceChildren(loadingBody());
    const containers = this.pendingNested.get(entryId) ?? new Set<HTMLElement>();
    const alreadyPending = containers.size > 0;
    containers.add(body); // every open block sharing this entryId resolves together
    this.pendingNested.set(entryId, containers);
    if (!alreadyPending) {
      this.deps.postMessage({ type: "requestVaultSessionDetail", entryId });
    }
  }
}
