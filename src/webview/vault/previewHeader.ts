// Pure builder for the floating preview's header (badge + title + action buttons
// + meta). Stateless: the caller passes callbacks and the current maximized flag,
// and owns the returned tooltip disposers (the header is rebuilt every render).

import type { VaultSessionDetail, VaultSessionEntry } from "../../vault/types";
import { getAgentIcon } from "./agentIcons";
import { agentLabel } from "./format";
import { ICON_CLOSE, ICON_MAXIMIZE, ICON_NAV_NEXT, ICON_NAV_PREV, ICON_RESTORE, ICON_RESUME } from "./icons";
import { buildPreviewMeta } from "./renderAtoms";
import { attachTooltip } from "../ui/Tooltip";

export interface PreviewHeaderCallbacks {
  isMaximized: () => boolean;
  onMovePointerDown: (ev: PointerEvent) => void;
  onPrevUser: () => void;
  onNextUser: () => void;
  onResume: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function buildPreviewHeader(
  entry: VaultSessionEntry,
  detail: VaultSessionDetail | undefined,
  cb: PreviewHeaderCallbacks,
): { element: HTMLElement; disposers: Array<() => void> } {
  const header = document.createElement("header");
  header.className = "vault-preview-header";
  // The whole header strip is the move handle; startMove guards action buttons + meta.
  header.addEventListener("pointerdown", (ev) => cb.onMovePointerDown(ev));

  const titleRow = document.createElement("div");
  titleRow.className = "vault-preview-title-row";
  const badge = document.createElement("span");
  badge.className = "vault-badge";
  badge.setAttribute("aria-label", agentLabel(entry.agent));
  const icon = getAgentIcon(entry.agent);
  if (icon) {
    badge.classList.add(`vault-badge--${icon.accent}`);
    badge.innerHTML = icon.svg;
  } else {
    badge.textContent = agentLabel(entry.agent).slice(0, 2);
  }
  const titleEl = document.createElement("h3");
  titleEl.className = "vault-preview-title";
  titleEl.textContent = entry.title || "(untitled session)";

  const actions = document.createElement("div");
  actions.className = "vault-preview-title-actions";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "vault-preview-icon-btn vault-preview-nav-prev";
  prevBtn.title = "Jump to previous user message";
  prevBtn.setAttribute("aria-label", "Jump to previous user message");
  prevBtn.innerHTML = ICON_NAV_PREV;
  prevBtn.addEventListener("click", () => cb.onPrevUser());
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "vault-preview-icon-btn vault-preview-nav-next";
  nextBtn.title = "Jump to next user message";
  nextBtn.setAttribute("aria-label", "Jump to next user message");
  nextBtn.innerHTML = ICON_NAV_NEXT;
  nextBtn.addEventListener("click", () => cb.onNextUser());
  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.className = "vault-preview-resume";
  resumeBtn.title = "Resume session";
  resumeBtn.setAttribute("aria-label", "Resume session");
  resumeBtn.innerHTML = ICON_RESUME;
  resumeBtn.addEventListener("click", () => cb.onResume());
  const maximizeBtn = document.createElement("button");
  maximizeBtn.type = "button";
  maximizeBtn.className = "vault-preview-icon-btn vault-preview-maximize";
  const maxLabel = cb.isMaximized() ? "Restore size" : "Expand to full size";
  maximizeBtn.title = maxLabel;
  maximizeBtn.setAttribute("aria-label", maxLabel);
  maximizeBtn.setAttribute("aria-pressed", cb.isMaximized() ? "true" : "false");
  maximizeBtn.innerHTML = cb.isMaximized() ? ICON_RESTORE : ICON_MAXIMIZE;
  maximizeBtn.addEventListener("click", () => cb.onToggleMaximize());
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "vault-preview-icon-btn vault-preview-close";
  closeBtn.title = "Close preview";
  closeBtn.setAttribute("aria-label", "Close preview");
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.addEventListener("click", () => cb.onClose());
  actions.append(prevBtn, nextBtn, resumeBtn, maximizeBtn, closeBtn);

  // Custom hover tooltips (native `title` is slow/unreliable in webviews). Maximize
  // uses getText since its label flips with state. Disposers returned to the caller.
  const disposers = [
    attachTooltip(prevBtn),
    attachTooltip(nextBtn),
    attachTooltip(resumeBtn),
    attachTooltip(maximizeBtn, { getText: () => (cb.isMaximized() ? "Restore size" : "Expand to full size") }),
    attachTooltip(closeBtn),
  ];

  titleRow.append(badge, titleEl, actions);
  header.appendChild(titleRow);
  header.appendChild(buildPreviewMeta(entry, detail));
  return { element: header, disposers };
}
