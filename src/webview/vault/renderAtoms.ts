// src/webview/vault/renderAtoms.ts — Pure DOM "atom" builders for the AI-vault
// panel + preview. Each takes data and returns an HTMLElement; none read panel
// state (`this`). Untrusted text is ALWAYS written via textContent (or the safe
// markdown-lite renderer, which never uses innerHTML) — never raw innerHTML.

import type {
  VaultActivityStep,
  VaultMessageTokens,
  VaultSessionDetail,
  VaultSessionEntry,
  VaultTimelineItem,
} from "../../vault/types";
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
export function previewMessage(
  kind: string,
  roleLabel: string,
  text: string,
  rich = false,
  meta?: HTMLElement | null,
): HTMLElement {
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
  // Per-message model + token usage (enhance-vault-sessions D3/D6) — assistant
  // messages only; omitted entirely when the reader recorded no model/tokens.
  if (meta) {
    wrap.appendChild(meta);
  }
  return wrap;
}

/** Compact token count: 1234 → "1.2k", 12345 → "12k", 456 → "456". */
function formatTokenCount(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  }
  return String(n);
}

/**
 * Per-assistant-message meta line (enhance-vault-sessions D3/D6): model + input/
 * output token usage, plus the context window when the agent records it (Codex).
 * Returns null when there is nothing to show so the caller omits the line entirely.
 */
export function buildMessageMeta(model?: string, tokens?: VaultMessageTokens): HTMLElement | null {
  const parts: string[] = [];
  if (model) {
    parts.push(model);
  }
  if (tokens) {
    if (typeof tokens.input === "number") {
      parts.push(`${formatTokenCount(tokens.input)} in`);
    }
    if (typeof tokens.output === "number") {
      parts.push(`${formatTokenCount(tokens.output)} out`);
    }
    if (typeof tokens.contextWindow === "number") {
      parts.push(`${formatTokenCount(tokens.contextWindow)} ctx`);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  const el = document.createElement("div");
  el.className = "vault-preview-message-meta";
  el.textContent = parts.join(" · ");
  return el;
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

/**
 * An AskUserQuestion turn: each question with the user's chosen answer (or an
 * italic "Awaiting answer" when the call was still pending). The prompt + answer
 * always show; when the call carried options, the role line becomes a toggle that
 * reveals the full choice list (descriptions, picked one highlighted) on click.
 */
export function questionBlock(item: Extract<VaultTimelineItem, { kind: "question" }>): HTMLElement {
  const hasOptions = item.questions.some((q) => (q.options?.length ?? 0) > 0);
  const wrap = document.createElement("div");
  wrap.className = "vault-preview-message vault-preview-message-question";
  const roleLabel = item.questions.length > 1 ? `Question · ${item.questions.length}` : "Question";

  if (hasOptions) {
    wrap.classList.add("is-collapsible");
    const head = document.createElement("button");
    head.type = "button";
    head.className = "vault-preview-message-role vault-preview-question-head";
    head.title = "Show the options";
    const firstPrompt = item.questions[0]?.prompt;
    head.setAttribute("aria-label", firstPrompt ? `Show options for: ${firstPrompt}` : "Show the options");
    head.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = roleLabel;
    const chevron = document.createElement("span");
    chevron.className = "vault-preview-question-chevron";
    chevron.innerHTML = ICON_CHEVRON_DOWN;
    chevron.setAttribute("aria-hidden", "true");
    head.append(roleDot(), label, chevron);
    head.addEventListener("click", () => {
      const expanded = wrap.classList.toggle("is-expanded");
      head.setAttribute("aria-expanded", expanded ? "true" : "false");
      head.title = expanded ? "Hide the options" : "Show the options";
    });
    wrap.append(head);
  } else {
    const role = document.createElement("div");
    role.className = "vault-preview-message-role";
    const label = document.createElement("span");
    label.textContent = roleLabel;
    role.append(roleDot(), label);
    wrap.append(role);
  }

  for (const q of item.questions) {
    const prompt = document.createElement("p");
    prompt.className = "vault-preview-question-prompt";
    prompt.textContent = q.prompt;
    const answer = document.createElement("p");
    answer.className = "vault-preview-question-answer";
    if (q.answer) {
      const arrow = document.createElement("span");
      arrow.className = "vault-preview-question-arrow";
      arrow.textContent = "→ ";
      arrow.setAttribute("aria-hidden", "true");
      answer.append(arrow, document.createTextNode(q.answer));
    } else {
      answer.classList.add("is-pending");
      answer.textContent = "Awaiting answer";
    }
    wrap.append(prompt, answer);
    if (q.options?.length) {
      wrap.append(questionOptions(q.options));
    }
  }
  return wrap;
}

/** The collapsible option list for one question — each option's label + optional
 *  description, with the user's pick highlighted. Hidden until the block expands. */
function questionOptions(
  options: NonNullable<Extract<VaultTimelineItem, { kind: "question" }>["questions"][number]["options"]>,
): HTMLElement {
  const list = document.createElement("ul");
  list.className = "vault-preview-question-options";
  for (const o of options) {
    const li = document.createElement("li");
    li.className = "vault-preview-question-option";
    if (o.chosen) {
      li.classList.add("is-chosen");
    }
    const label = document.createElement("span");
    label.className = "vault-preview-question-option-label";
    label.textContent = o.label;
    li.append(label);
    if (o.description) {
      const desc = document.createElement("span");
      desc.className = "vault-preview-question-option-desc";
      desc.textContent = o.description;
      li.append(desc);
    }
    list.append(li);
  }
  return list;
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
