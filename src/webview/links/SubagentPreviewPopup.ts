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
// geometry remembered IN-MEMORY for the session (no disk persistence), and the
// transcript renders FLAT (a stub timeline bag — nested sub-subagent nodes are
// non-expandable; oracle finding #2 / D6).

import type { VaultSessionDetail } from "../../vault/types";
import type { VaultPreviewGeometry } from "../state/WebviewState";
import { getAgentIcon } from "../vault/agentIcons";
import { FloatingPreviewShell } from "../vault/FloatingPreviewShell";
import { formatStats } from "../vault/format";
import { ICON_AGENT } from "../vault/icons";
import { buildPreviewHeader } from "../vault/previewHeader";
import { type PreviewTimelineBag, renderNestedInto } from "../vault/previewTimeline";
import { emptyState, loadingBody } from "../vault/renderAtoms";
import { computePosition } from "./HoverPreviewPopup";

/** Flat-render bag: every run renders in full (no "Show N more"), and nested
 *  blocks never expand to content — MVP shows them as non-expandable lines (D6). */
const FLAT_BAG: PreviewTimelineBag = {
  isRunExpanded: () => true,
  onExpandRun: () => {},
  isNestedExpanded: () => false,
  setNestedExpanded: () => {},
  populateNested: () => {},
  getBoardSelection: () => undefined,
  setBoardSelection: () => {},
};

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
}

export class SubagentPreviewPopup {
  private readonly container: HTMLElement;
  private shell: FloatingPreviewShell | null = null;
  /** The request this popup is currently waiting on; a response must match it. */
  private requestId: string | null = null;
  private agentType = "";
  private description = "";
  private anchorX = 0;
  private anchorY = 0;
  /** In-memory geometry so a resized/moved/maximized popup keeps its shape across
   *  re-opens within the session (the singleton outlives each open). */
  private rememberedGeometry: VaultPreviewGeometry | null = null;

  constructor(deps: SubagentPreviewPopupDeps = {}) {
    this.container = deps.container ?? document.body;
  }

  /** Open (replacing any prior popup) at click coords in a loading state. */
  open(requestId: string, agentType: string, description: string, x: number, y: number): void {
    this.dispose(); // open-replace: a new click tears down the previous popup
    this.requestId = requestId;
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
      renderNestedInto(body, detail, detail.entryId, FLAT_BAG);
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

  /** Idempotent teardown via the shell (detach listeners + tooltips + remove node).
   *  Remembered geometry intentionally survives so the next open restores it. */
  dispose(): void {
    this.shell?.dispose();
    this.shell = null;
    this.requestId = null;
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
