// src/webview/vault/renderAtoms.ts — Pure DOM "atom" builders for the AI-vault
// panel + preview. Each takes data and returns an HTMLElement; none read panel
// state (`this`). Untrusted text is ALWAYS written via textContent (or the safe
// markdown-lite renderer, which never uses innerHTML) — never raw innerHTML.

import type { VaultActivityStep, VaultSessionDetail, VaultSessionEntry } from "../../vault/types";
import { formatRelativeTime, formatStats, leafSegment } from "./format";
import { ICON_CHEVRON_DOWN } from "./icons";
import { renderMarkdownLite } from "./markdownLite";

/** Reasoning longer than this (or multi-line) collapses to a single-line gist
 *  with a chevron — reasoning is low-signal at a glance, so the preview keeps it
 *  to one clean line until the user expands it. */
const THINKING_INLINE_MAX = 90;

/** Preview meta block: Folder / Modified / Activity (when detail is in). */
export function buildPreviewMeta(entry: VaultSessionEntry, detail?: VaultSessionDetail): HTMLElement {
  const dl = document.createElement("dl");
  dl.className = "vault-preview-meta";
  const addRow = (term: string, value: string, title?: string) => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (title) {
      dd.title = title;
    }
    dl.append(dt, dd);
  };
  addRow("Folder", leafSegment(entry.cwd), entry.cwd);
  const modified = formatRelativeTime(entry.modified);
  if (modified) {
    addRow("Modified", modified);
  }
  if (detail) {
    addRow("Activity", formatStats(detail.stats));
  }
  return dl;
}

/** Loading placeholder body. */
export function loadingBody(): HTMLElement {
  const body = document.createElement("div");
  body.className = "vault-preview-loading";
  body.textContent = "Loading…";
  return body;
}

/** Leading dot for a preview message's role line (kind tints it via CSS). */
function roleDot(): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "vault-preview-dot";
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

/**
 * One preview message block (role line + body). The body is rendered either as
 * plain `textContent` (compact labels) or, when `rich`, through the safe
 * markdown-lite renderer (D17) so prose keeps its line breaks, code blocks, and
 * tables. Both paths put untrusted text into the DOM via textContent ONLY —
 * `renderMarkdownLite` never uses innerHTML — so the textContent-only safety rule
 * holds either way.
 */
export function previewMessage(kind: string, roleLabel: string, text: string, rich = false): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `vault-preview-message vault-preview-message-${kind}`;
  const role = document.createElement("div");
  role.className = "vault-preview-message-role";
  const roleText = document.createElement("span");
  roleText.textContent = roleLabel;
  role.append(roleDot(), roleText);
  if (rich) {
    const body = document.createElement("div");
    body.className = "vault-md";
    body.appendChild(renderMarkdownLite(text));
    wrap.append(role, body);
  } else {
    const p = document.createElement("p");
    p.textContent = text;
    wrap.append(role, p);
  }
  return wrap;
}

/** First non-empty line of reasoning, stripped of markdown noise — used as the
 *  one-line gist shown while a thinking block is collapsed. */
function thinkingGist(text: string): string {
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (firstLine ?? text.trim())
    .replace(/^[#>\-*\s]+/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * A reasoning block. Short reasoning renders inline. Long / multi-line reasoning
 * collapses to a single-line gist (`● THINKING  <gist…>  ⌄`) that expands to the
 * full markdown on click — reasoning is low-signal at a glance, and a 1-line
 * ellipsis is reliable where a multi-line clamp on the `.vault-md` block is not
 * (R5: `-webkit-line-clamp` can collapse block-child containers to height 0).
 */
export function thinkingBlock(text: string): HTMLElement {
  const collapsible = text.trim().length > THINKING_INLINE_MAX || text.includes("\n");
  if (!collapsible) {
    return previewMessage("thinking", "Thinking", text, true);
  }

  const wrap = document.createElement("div");
  wrap.className = "vault-preview-message vault-preview-message-thinking is-collapsible";

  // The head IS the toggle: role chip + one-line gist + chevron, all on one row.
  const head = document.createElement("button");
  head.type = "button";
  head.className = "vault-preview-thinking-head";
  head.title = "Show the full reasoning";
  head.setAttribute("aria-expanded", "false");

  const role = document.createElement("span");
  role.className = "vault-preview-message-role";
  const label = document.createElement("span");
  label.textContent = "Thinking";
  role.append(roleDot(), label);

  const gist = document.createElement("span");
  gist.className = "vault-preview-thinking-gist";
  gist.textContent = thinkingGist(text);

  const chevron = document.createElement("span");
  chevron.className = "vault-preview-thinking-chevron";
  chevron.innerHTML = ICON_CHEVRON_DOWN;
  chevron.setAttribute("aria-hidden", "true");
  head.append(role, gist, chevron);

  const body = document.createElement("div");
  body.className = "vault-md vault-preview-thinking-body";
  body.appendChild(renderMarkdownLite(text));

  head.addEventListener("click", () => {
    const expanded = wrap.classList.toggle("is-expanded");
    head.setAttribute("aria-expanded", expanded ? "true" : "false");
    head.title = expanded ? "Collapse the reasoning" : "Show the full reasoning";
  });

  wrap.append(head, body);
  return wrap;
}

/** Render one recent-activity step (tool call or subagent invocation). */
export function activityStep(step: VaultActivityStep): HTMLElement {
  if (step.kind === "subagent") {
    const label = `Subagent → ${step.name}`;
    return previewMessage("subagent", label, step.prompt ?? "");
  }
  const wrap = document.createElement("div");
  wrap.className = "vault-preview-message vault-preview-message-tool";
  const role = document.createElement("div");
  role.className = "vault-preview-message-role";
  const roleText = document.createElement("span");
  roleText.textContent = step.tool;
  role.append(roleDot(), roleText);
  const p = document.createElement("p");
  p.textContent = step.detail ?? "";
  if (step.diff) {
    const sep = document.createElement("span");
    sep.className = "vault-preview-mute";
    sep.textContent = " · ";
    const add = document.createElement("span");
    add.className = "vault-preview-diff-add";
    add.textContent = `+${step.diff.added}`;
    const del = document.createElement("span");
    del.className = "vault-preview-diff-del";
    del.textContent = ` −${step.diff.removed}`;
    p.append(sep, add, del);
  }
  wrap.append(role, p);
  return wrap;
}

/** Build an empty / no-match panel (icon + title + body), all via textContent. */
export function emptyState(iconSvg: string, title: string, body: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "vault-empty";
  const icon = document.createElement("span");
  icon.className = "vault-empty-icon";
  icon.innerHTML = iconSvg;
  icon.setAttribute("aria-hidden", "true");
  const titleEl = document.createElement("div");
  titleEl.className = "vault-empty-title";
  titleEl.textContent = title;
  const bodyEl = document.createElement("div");
  bodyEl.className = "vault-empty-body";
  bodyEl.textContent = body;
  wrap.append(icon, titleEl, bodyEl);
  return wrap;
}
