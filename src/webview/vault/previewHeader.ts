// Pure builder for the floating preview's header (badge + optional agent chip +
// title + action buttons + optional meta). Stateless and consumer-agnostic: the
// caller passes a normalized model + callbacks, so the vault session preview and
// the subagent popup render through ONE builder and cannot drift. Vault-only
// actions (prev/next-user, resume) render only when their callback is supplied.

import { attachTooltip } from "../ui/Tooltip";
import type { AgentIcon } from "./agentIcons";
import { ICON_CLOSE, ICON_MAXIMIZE, ICON_NAV_NEXT, ICON_NAV_PREV, ICON_RESTORE, ICON_RESUME } from "./icons";

export interface PreviewHeaderModel {
  /** Brand badge: the resolved icon, or a text fallback when none. */
  badge: { icon?: AgentIcon; ariaLabel?: string; fallbackText?: string };
  /** Optional chip between badge and title (subagent `@agentType`). */
  chip?: { text: string; className: string };
  /** Session git branch (enhance-vault-sessions D2/D3) — renders a `⎇ <branch>`
   *  chip in the title row when set (Claude/Codex; absent for OpenCode). */
  branch?: string;
  title: string;
  /** Pre-built meta block (vault Folder/Modified/Activity, or subagent Activity). */
  meta?: HTMLElement;
}

export interface PreviewHeaderCallbacks {
  isMaximized: () => boolean;
  onMovePointerDown: (ev: PointerEvent) => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  /** Render prev/next-user nav only when both are provided (vault only). */
  onPrevUser?: () => void;
  onNextUser?: () => void;
  /** Render the Resume button only when provided (vault only). */
  onResume?: () => void;
}

export function buildPreviewHeader(
  model: PreviewHeaderModel,
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
  if (model.badge.ariaLabel) {
    badge.setAttribute("aria-label", model.badge.ariaLabel);
  }
  if (model.badge.icon) {
    badge.classList.add(`vault-badge--${model.badge.icon.accent}`);
    badge.innerHTML = model.badge.icon.svg;
  } else {
    badge.textContent = model.badge.fallbackText ?? "";
  }

  const titleEl = document.createElement("h3");
  titleEl.className = "vault-preview-title";
  titleEl.textContent = model.title;

  const actions = document.createElement("div");
  actions.className = "vault-preview-title-actions";
  const disposers: Array<() => void> = [];

  // Vault-only prev/next-user nav (both or neither).
  if (cb.onPrevUser && cb.onNextUser) {
    const prevBtn = iconButton("vault-preview-nav-prev", "Jump to previous user message", ICON_NAV_PREV, cb.onPrevUser);
    const nextBtn = iconButton("vault-preview-nav-next", "Jump to next user message", ICON_NAV_NEXT, cb.onNextUser);
    actions.append(prevBtn, nextBtn);
    disposers.push(attachTooltip(prevBtn), attachTooltip(nextBtn));
  }
  // Vault-only Resume (a subagent is not independently launchable).
  if (cb.onResume) {
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "vault-preview-resume";
    resumeBtn.title = "Resume session";
    resumeBtn.setAttribute("aria-label", "Resume session");
    resumeBtn.innerHTML = ICON_RESUME;
    resumeBtn.addEventListener("click", () => cb.onResume?.());
    actions.appendChild(resumeBtn);
    disposers.push(attachTooltip(resumeBtn));
  }

  const maximized = cb.isMaximized();
  const maximizeBtn = document.createElement("button");
  maximizeBtn.type = "button";
  maximizeBtn.className = "vault-preview-icon-btn vault-preview-maximize";
  const maxLabel = maximized ? "Restore size" : "Expand to full size";
  maximizeBtn.title = maxLabel;
  maximizeBtn.setAttribute("aria-label", maxLabel);
  maximizeBtn.setAttribute("aria-pressed", maximized ? "true" : "false");
  maximizeBtn.innerHTML = maximized ? ICON_RESTORE : ICON_MAXIMIZE;
  maximizeBtn.addEventListener("click", () => cb.onToggleMaximize());

  const closeBtn = iconButton("vault-preview-close", "Close preview", ICON_CLOSE, cb.onClose);
  actions.append(maximizeBtn, closeBtn);

  // Custom hover tooltips (native `title` is slow/unreliable in webviews). Maximize
  // uses getText since its label flips with state. Disposers returned to the caller.
  disposers.push(
    attachTooltip(maximizeBtn, { getText: () => (cb.isMaximized() ? "Restore size" : "Expand to full size") }),
    attachTooltip(closeBtn),
  );

  titleRow.appendChild(badge);
  if (model.chip) {
    const chip = document.createElement("span");
    chip.className = model.chip.className;
    chip.textContent = model.chip.text;
    titleRow.appendChild(chip);
  }
  if (model.branch) {
    const branchChip = document.createElement("span");
    branchChip.className = "vault-preview-branch-chip";
    branchChip.title = `Git branch: ${model.branch}`;
    const icon = document.createElement("span");
    icon.className = "vault-preview-branch-icon";
    icon.textContent = "⎇";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "vault-preview-branch-name";
    name.textContent = model.branch;
    branchChip.append(icon, name);
    titleRow.appendChild(branchChip);
  }
  titleRow.append(titleEl, actions);
  header.appendChild(titleRow);
  if (model.meta) {
    header.appendChild(model.meta);
  }
  return { element: header, disposers };
}

/** A `.vault-preview-icon-btn` with svg + aria/title; click wired. */
function iconButton(cls: string, label: string, svg: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `vault-preview-icon-btn ${cls}`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = svg;
  btn.addEventListener("click", () => onClick());
  return btn;
}
