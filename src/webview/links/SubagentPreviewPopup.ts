// src/webview/links/SubagentPreviewPopup.ts — A single, body-mounted popup that
// previews a clicked subagent's sub-session transcript next to the click.
//
// Reuses the SAME chrome as the vault session preview (FloatingPreviewShell) and
// the SAME header builder, so it looks identical and cannot drift:
//   - `.vault-preview` card + FloatingWindow (resize / move / maximize),
//   - a session-style header (agent badge + `@<agentType>` chip + description title
//     + maximize/close + Activity meta) via `buildPreviewHeader`,
//   - PreviewScrollNav FABs,
//   - the shared transcript renderer `renderNestedInto`.
//
// Differences from the vault preview: anchored at the CLICK (not a list row),
// no Resume / prev-next-user actions (a subagent is not independently launchable),
// geometry remembered IN-MEMORY for the session (no disk persistence), and runs
// render in full (no "Show N more"). Nested sub-subagent nodes ARE expandable: a
// real timeline bag fetches the child by its entryId on demand, mirroring the vault
// panel's PreviewController (support-nested-subagent-preview D5).

import type { RequestSubagentPreviewMessage } from "../../types/messages";
import type { VaultSessionDetail } from "../../vault/types";
import type { VaultPreviewGeometry } from "../state/WebviewState";
import { getAgentIcon } from "../vault/agentIcons";
import { FloatingPreviewShell } from "../vault/FloatingPreviewShell";
import { formatStats } from "../vault/format";
import { ICON_AGENT } from "../vault/icons";
import { buildPreviewHeader } from "../vault/previewHeader";
import { type BoardSelection, type PreviewTimelineBag, renderNestedInto } from "../vault/previewTimeline";
import { emptyState, loadingBody } from "../vault/renderAtoms";
import { computePosition } from "./HoverPreviewPopup";

/** Human copy for each error/empty marker the host can reply with. */
function errorCopy(error?: string): { title: string; body: string } {
  switch (error) {
    case "noSession":
      return { title: "No running Claude session", body: "Couldn't match this terminal to a live Claude session." };
    case "notFound":
      return { title: "Subagent not found", body: "No subagent transcript matched this line." };
    default:
      return { title: "Couldn't load subagent", body: error || "Failed to read the subagent transcript." };
  }
}

export interface SubagentPreviewPopupDeps {
  /** Mount target — defaults to `document.body`. Injected for tests. */
  container?: HTMLElement;
  /** Post a message to the host. Required for NESTED drill-down (the popup fetches
   *  a sub-subagent's transcript via `requestSubagentPreview{entryId}`). Absent →
   *  nested blocks render but expanding one is a no-op (e.g. legacy callers/tests). */
  postMessage?: (msg: RequestSubagentPreviewMessage) => void;
}

export class SubagentPreviewPopup {
  private readonly container: HTMLElement;
  private readonly postMessage?: (msg: RequestSubagentPreviewMessage) => void;
  private shell: FloatingPreviewShell | null = null;
  /** The request this popup is currently waiting on; a response must match it. */
  private requestId: string | null = null;
  /** Source terminal of the open popup — passed back on nested requests (the host
   *  ignores it when an `entryId` is present, but the message shape requires it). */
  private terminalId = "";
  private agentType = "";
  private description = "";
  private anchorX = 0;
  private anchorY = 0;
  private nestedReqSeq = 0;
  /** Nested subagent expansion state, keyed by child entryId — mirrors
   *  PreviewController. `nestedDetails` caches fetched child transcripts;
   *  `pendingNested` routes an in-flight response to its block(s); `renderingNested`
   *  breaks a self-referential cycle. All reset on `dispose()`. */
  private readonly expandedNested = new Set<string>();
  private readonly nestedDetails = new Map<string, VaultSessionDetail>();
  private readonly pendingNested = new Map<string, Set<HTMLElement>>();
  private readonly renderingNested = new Set<string>();
  private readonly boardSelections = new Map<string, BoardSelection>();
  /** In-memory geometry so a resized/moved/maximized popup keeps its shape across
   *  re-opens within the session (the singleton outlives each open). */
  private rememberedGeometry: VaultPreviewGeometry | null = null;
  /** Real timeline bag: runs render full (no "Show N more"), nested blocks expand
   *  on demand via {@link populateNested} (support-nested-subagent-preview D5). */
  private readonly bag: PreviewTimelineBag = {
    isRunExpanded: () => true,
    onExpandRun: () => {},
    isNestedExpanded: (entryId) => this.expandedNested.has(entryId),
    setNestedExpanded: (entryId, expanded) => {
      if (expanded) {
        this.expandedNested.add(entryId);
      } else {
        // Collapse drops any in-flight request so a late response can't populate the
        // now-hidden body.
        this.expandedNested.delete(entryId);
        this.pendingNested.delete(entryId);
      }
    },
    populateNested: (entryId, body) => this.populateNested(entryId, body),
    getBoardSelection: (boardKey) => this.boardSelections.get(boardKey),
    setBoardSelection: (boardKey, selection) => {
      this.boardSelections.set(boardKey, selection);
    },
  };

  constructor(deps: SubagentPreviewPopupDeps = {}) {
    this.container = deps.container ?? document.body;
    this.postMessage = deps.postMessage;
  }

  /** Open (replacing any prior popup) at click coords in a loading state. */
  open(requestId: string, agentType: string, description: string, x: number, y: number, terminalId = ""): void {
    this.dispose(); // open-replace: a new click tears down the previous popup
    this.requestId = requestId;
    this.terminalId = terminalId;
    this.agentType = agentType;
    this.description = description;
    this.anchorX = x;
    this.anchorY = y;

    this.shell = new FloatingPreviewShell({
      ariaLabel: "Subagent transcript preview",
      role: "dialog",
      // Reuse the vault preview card + the claude accent (subagents are Claude).
      classNames: ["vault-preview--claude"],
      getAnchorRow: () => null, // anchored at the click, not a list row
      initialGeometry: () => this.rememberedGeometry,
      persistGeometry: (geometry) => {
        this.rememberedGeometry = geometry;
      },
      onScrollTop: () => this.shell?.scrollNav.scrollBody(0),
      onRequestClose: () => this.dispose(),
      captureCloseListeners: true,
    });
    this.container.appendChild(this.shell.el);
    this.renderShellContent(this.bodyContainer(loadingBody()));
    this.shell.show(); // is-open + applies remembered geometry/maximized, else no-op place
    if (!this.rememberedGeometry) {
      this.positionAtClick(); // first open with no remembered geometry → anchor at click
    }
  }

  /**
   * Fill the popup with the resolved transcript (flat) or an empty/error state.
   * Ignored when the popup is closed or the response is for a stale request.
   */
  setContent(requestId: string, detail?: VaultSessionDetail, error?: string): void {
    if (!this.shell || requestId !== this.requestId) {
      return; // closed, replaced, or stale response → drop it
    }
    if (detail) {
      const body = this.bodyContainer();
      renderNestedInto(body, detail, detail.entryId, this.bag);
      this.renderShellContent(body, detail);
      this.shell.scrollNav.scrollToEnd(); // open on the latest part of the transcript (its outcome)
    } else {
      const copy = errorCopy(error);
      this.renderShellContent(this.bodyContainer(emptyState(ICON_AGENT, copy.title, copy.body)));
    }
    if (!this.rememberedGeometry) {
      this.positionAtClick(); // content height changed — re-clamp against the viewport
    }
  }

  /** True while a popup is mounted (used by routing/tests). */
  isOpen(): boolean {
    return this.shell !== null;
  }

  /**
   * Fill a nested subagent block's body: from cache (cycle-guarded), or lazily fetch
   * the child by its `entryId` via `requestSubagentPreview{entryId}` — the echoed
   * `subagentPreviewResponse` routes back through {@link handleNestedResponse}
   * (support-nested-subagent-preview D5). Mirrors PreviewController.populateNested.
   */
  private populateNested(entryId: string, body: HTMLElement): void {
    const cached = this.nestedDetails.get(entryId);
    if (cached) {
      if (this.renderingNested.has(entryId)) {
        body.replaceChildren(); // a child that nests its own id → stop, don't overflow
        return;
      }
      this.renderingNested.add(entryId);
      try {
        renderNestedInto(body, cached, entryId, this.bag);
      } finally {
        this.renderingNested.delete(entryId);
      }
      return;
    }
    if (!this.postMessage) {
      // No host channel (degraded caller / test) → an inert placeholder, never a
      // spinner that can't resolve (review S1).
      body.replaceChildren(
        emptyState(ICON_AGENT, "Nested preview unavailable", "Couldn't open this sub-session here."),
      );
      return;
    }
    body.replaceChildren(loadingBody());
    const containers = this.pendingNested.get(entryId) ?? new Set<HTMLElement>();
    const alreadyPending = containers.size > 0;
    containers.add(body); // every open block sharing this entryId resolves together
    this.pendingNested.set(entryId, containers);
    if (!alreadyPending) {
      // The reply is correlated back by `entryId` (handleNestedResponse), NOT by this
      // `requestId` — the nested path routes per child, so requestId is unused on the
      // response side (review S2). It's still sent to satisfy the message shape.
      this.postMessage({
        type: "requestSubagentPreview",
        terminalId: this.terminalId,
        requestId: `subagent-nested-${++this.nestedReqSeq}`,
        description: "",
        x: 0,
        y: 0,
        entryId,
      });
    }
  }

  /** Route a host reply for a nested fetch (`subagentPreviewResponse` echoing
   *  `entryId`) into the block(s) awaiting it. Dropped when the popup is closed or
   *  the block was collapsed (no pending container). */
  handleNestedResponse(entryId: string, detail?: VaultSessionDetail, error?: string): void {
    if (!this.shell) {
      return;
    }
    const containers = this.pendingNested.get(entryId);
    if (!containers) {
      return; // closed block / stale → drop
    }
    this.pendingNested.delete(entryId);
    if (detail && !error) {
      this.nestedDetails.set(entryId, detail);
      for (const container of containers) {
        renderNestedInto(container, detail, entryId, this.bag);
      }
    } else {
      const text = error ?? "Couldn't read this sub-session.";
      for (const container of containers) {
        container.textContent = text;
      }
    }
  }

  /** Idempotent teardown via the shell (detach listeners + tooltips + remove node).
   *  Nested expansion/fetch state is reset so a late response can't touch a stale
   *  node; remembered geometry intentionally survives so the next open restores it. */
  dispose(): void {
    this.shell?.dispose();
    this.shell = null;
    this.requestId = null;
    this.expandedNested.clear();
    this.nestedDetails.clear();
    this.pendingNested.clear();
    this.renderingNested.clear();
    this.boardSelections.clear();
  }

  /** Wrap content in the scroll container PreviewScrollNav re-queries each render. */
  private bodyContainer(child?: HTMLElement): HTMLElement {
    const body = document.createElement("div");
    body.className = "vault-preview-body";
    if (child) {
      body.appendChild(child);
    }
    return body;
  }

  /** Build the shared header + assemble it with the body through the shell. */
  private renderShellContent(bodyEl: HTMLElement, detail?: VaultSessionDetail): void {
    if (!this.shell) {
      return;
    }
    this.shell.disposeTooltips();
    this.shell.render(this.buildHeader(detail), bodyEl);
  }

  /** Session-preview-style header via the shared builder: claude badge + @agentType
   *  chip + description title + maximize/close (no resume/nav), Activity meta once in. */
  private buildHeader(detail?: VaultSessionDetail): HTMLElement {
    const { element, disposers } = buildPreviewHeader(
      {
        badge: { icon: getAgentIcon("claude"), fallbackText: "CL" },
        chip: { text: this.agentType ? `@${this.agentType}` : "@subagent", className: "vault-preview-subagent-agent" },
        title: this.description || "Subagent",
        meta: detail ? this.activityMeta(detail) : undefined,
      },
      {
        isMaximized: () => this.shell?.floatingWindow.isMaximized() ?? false,
        onMovePointerDown: (ev) => this.shell?.floatingWindow.startMove(ev),
        onToggleMaximize: () => this.shell?.floatingWindow.toggleMaximize(),
        onClose: () => this.dispose(),
      },
    );
    this.shell?.trackTooltips(disposers);
    return element;
  }

  /** The single Activity meta row (subagents have no folder/modified metadata). */
  private activityMeta(detail: VaultSessionDetail): HTMLElement {
    const dl = document.createElement("dl");
    dl.className = "vault-preview-meta";
    const dt = document.createElement("dt");
    dt.textContent = "Activity";
    const dd = document.createElement("dd");
    dd.textContent = formatStats(detail.stats);
    dl.append(dt, dd);
    return dl;
  }

  private positionAtClick(): void {
    if (!this.shell || this.shell.floatingWindow.isMaximized()) {
      return;
    }
    const el = this.shell.el;
    const rect = el.getBoundingClientRect();
    const width = rect.width || 560;
    const height = rect.height || Math.min(window.innerHeight * 0.7, 560);
    const pos = computePosition(this.anchorX, this.anchorY, width, height, window.innerWidth, window.innerHeight);
    el.style.right = "auto";
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  }
}
