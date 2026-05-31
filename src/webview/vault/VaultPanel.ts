// src/webview/vault/VaultPanel.ts — Flat, searchable AI-vault session list.
// See: asimov/changes/add-ai-coding-vault/specs/vault-panel/spec.md,
//      design.md D10 (mirrors FileTreePanel's composition, NOT its Tree).
//
// Renders the aggregated session list as a plain list with a client-side search
// box (no per-keystroke host round-trip). Session titles are UNTRUSTED (derived
// from agent transcripts) — every dynamic string is written via textContent,
// never innerHTML, so a crafted title cannot inject markup.

import type {
  RequestVaultSessionDetailMessage,
  RequestVaultSessionsMessage,
  VaultCopyFilePathMessage,
  VaultCopyResumeCommandMessage,
  VaultOpenSessionFileMessage,
  VaultOpenWorkingDirMessage,
  VaultResumeMessage,
  VaultRevealInOSMessage,
  VaultSessionDetailResponseMessage,
} from "../../types/messages";
import type {
  VaultActivityStep,
  VaultListResult,
  VaultSessionDetail,
  VaultSessionEntry,
  VaultTimelineItem,
} from "../../vault/types";
import { attachTooltip } from "../ui/Tooltip";
import type { VaultPreviewGeometry } from "../state/WebviewState";
import { getAgentAccent, getAgentDisplayName, getAgentIcon, VAULT_ACCENTS } from "./agentIcons";
import { type GroupMode, groupEntries } from "./grouping";
import { renderMarkdownLite } from "./markdownLite";
import { entriesSignature } from "./vaultRenderSignature";

/** Every message the panel can post — all webview→host vault messages carry entryId only. */
export type VaultPanelPostMessage = (
  m:
    | RequestVaultSessionsMessage
    | VaultResumeMessage
    | RequestVaultSessionDetailMessage
    | VaultRevealInOSMessage
    | VaultOpenSessionFileMessage
    | VaultOpenWorkingDirMessage
    | VaultCopyResumeCommandMessage
    | VaultCopyFilePathMessage,
) => void;

// Inline UI glyphs (no codicon font is bundled — the webview uses inline SVGs,
// matching FileTreePanel). Static, trusted strings only — never session data.
const ICON_FOLDER =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4h4l1.3 1.3H14.5v8h-13z"/></svg>';
const ICON_RESUME =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M5 3.4v9.2l7-4.6z"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>';
const ICON_RECENT =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4.5v3.7l2.4 1.4"/><path d="M2.6 8a5.4 5.4 0 1 1 1.6 3.8"/><path d="M2.4 12v-2.3h2.3"/></svg>';
const ICON_AGENT =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="5" r="2"/><circle cx="11" cy="6" r="1.6"/><path d="M1.8 13c0-2 1.6-3.3 3.7-3.3S9.2 11 9.2 13"/><path d="M9.6 13c0-1.5 1.1-2.6 2.6-2.6 1.4 0 2 0.9 2 2.2"/></svg>';
const ICON_REFRESH =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.3 7a5.3 5.3 0 1 0-.3 3"/><path d="M13.5 3v3h-3"/></svg>';
const ICON_CHEVRON_DOWN =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
const ICON_NAV_PREV =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>';
const ICON_NAV_NEXT =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
// Jump-to-top: a bar over an up chevron. Jump-to-bottom: a down chevron over a bar.
const ICON_SCROLL_TOP =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3.5h8"/><path d="M4.5 9l3.5-3.5L11.5 9"/></svg>';
const ICON_SCROLL_BOTTOM =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7l3.5 3.5L11.5 7"/><path d="M4 12.5h8"/></svg>';
const ICON_ARCHIVE =
  '<svg viewBox="0 0 16 16" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="3"/><path d="M3 6v7h10V6"/><line x1="6.5" y1="9" x2="9.5" y2="9"/></svg>';
const ICON_OPEN =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M9 2H4v12h8V5z"/><path d="M9 2v3h3"/></svg>';
const ICON_REVEAL =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 5h4l1.3-1.3H10V5h4.5l-1 8.5h-12z"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/></svg>';
const ICON_TERMINAL =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6l2.5 2L4 10"/><line x1="8" y1="10.5" x2="11" y2="10.5"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
const ICON_MAXIMIZE =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5l-4.5 4.5"/><path d="M6.5 13.5h-4v-4"/><path d="M2.5 13.5l4.5-4.5"/></svg>';
const ICON_RESTORE =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3l-4 4m0-4v4h4"/><path d="M3 13l4-4m0 4v-4H3"/></svg>';
/** Rows shown per group before a "Show more" affordance keeps the list scannable. */
const MAX_VISIBLE_PER_GROUP = 10;

/** Reasoning longer than this (or multi-line) collapses to a single-line gist
 *  with a chevron — reasoning is low-signal at a glance, so the preview keeps it
 *  to one clean line until the user expands it. */
const THINKING_INLINE_MAX = 90;

/** Timeline items requested on the first open, and the step added per load-more. */
const PREVIEW_LIMIT_DEFAULT = 400;
const PREVIEW_LIMIT_STEP = 400;

/** Last path segment (folder leaf) for the cwd chip. */
function leafSegment(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed || cwd;
}

/** Drop leading/trailing separators and collapse consecutive ones. */
function collapseSeparators<T>(items: (T | "sep")[]): (T | "sep")[] {
  const out: (T | "sep")[] = [];
  for (const it of items) {
    if (it === "sep") {
      if (out.length === 0 || out[out.length - 1] === "sep") {
        continue;
      }
    }
    out.push(it);
  }
  while (out.length > 0 && out[out.length - 1] === "sep") {
    out.pop();
  }
  return out;
}

/** Compact token count: 1650 → "1.6k". */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Activity summary line: "24 msgs · 18.2k tok · 8 tools · 1 subagent". */
function formatStats(stats: VaultSessionDetail["stats"]): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [plural(stats.messageCount, "msg")];
  if (stats.tokenCount !== undefined) {
    parts.push(`${formatTokens(stats.tokenCount)} tok`);
  }
  parts.push(plural(stats.toolCount, "tool"));
  if (stats.subagentCount > 0) {
    parts.push(plural(stats.subagentCount, "subagent"));
  }
  return parts.join(" · ");
}

/** Preview meta block: Folder / Modified / Activity (when detail is in). */
function buildPreviewMeta(entry: VaultSessionEntry, detail?: VaultSessionDetail): HTMLElement {
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
function loadingBody(): HTMLElement {
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
function previewMessage(kind: string, roleLabel: string, text: string, rich = false): HTMLElement {
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
  return (firstLine ?? text.trim()).replace(/^[#>\-*\s]+/, "").replace(/[*_`]/g, "").trim();
}

/**
 * A reasoning block. Short reasoning renders inline. Long / multi-line reasoning
 * collapses to a single-line gist (`● THINKING  <gist…>  ⌄`) that expands to the
 * full markdown on click — reasoning is low-signal at a glance, and a 1-line
 * ellipsis is reliable where a multi-line clamp on the `.vault-md` block is not
 * (R5: `-webkit-line-clamp` can collapse block-child containers to height 0).
 */
function thinkingBlock(text: string): HTMLElement {
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
 * Named teammate colors → concrete CSS values, so a teammate node's accent is
 * always visible under any theme. (The first team design failed by leaning on
 * theme vars like `--vscode-panel-border` that resolve to near-invisible.) The
 * `color` field is UNTRUSTED transcript data, so it is sanitized to this palette
 * or a strict hex literal before ever touching the CSSOM — anything else → a
 * neutral fallback. Used only as a `--turn-color` custom-property value.
 */
const TEAMMATE_COLORS: Record<string, string> = {
  blue: "#4aa3ff",
  green: "#3fb950",
  yellow: "#d8a23a",
  purple: "#a371f7",
  cyan: "#39c5cf",
  orange: "#e0823d",
  pink: "#f778ba",
  red: "#f85149",
  magenta: "#db61a2",
  gray: "#8b949e",
  grey: "#8b949e",
};
const TEAMMATE_COLOR_FALLBACK = "#8b949e";
function teammateAccent(color: string | undefined): string {
  if (!color) {
    return TEAMMATE_COLOR_FALLBACK;
  }
  const mapped = TEAMMATE_COLORS[color.toLowerCase()];
  if (typeof mapped === "string") {
    return mapped; // typeof-guard avoids prototype keys (toString/constructor)
  }
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : TEAMMATE_COLOR_FALLBACK;
}

/** Render one recent-activity step (tool call or subagent invocation). */
function activityStep(step: VaultActivityStep): HTMLElement {
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
function emptyState(iconSvg: string, title: string, body: string): HTMLElement {
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

export interface VaultPanelDeps {
  /** DOM host element (`#vault-panel`). */
  host: HTMLElement;
  postMessage: VaultPanelPostMessage;
  /** Reserved for future active-session highlighting; mirrors FileTreePanel (D10). */
  getActiveSessionId?: () => string | null;
  /** Initial collapsed state (default true). Read once on construction. */
  getInitialCollapsed?: () => boolean;
  /** Persist the collapsed state whenever it changes. */
  persistCollapsed?: (collapsed: boolean) => void;
  /** Initial "This folder only" filter state (default false). Read once. */
  getInitialFolderOnly?: () => boolean;
  /** Persist the "This folder only" filter state whenever it changes. */
  persistFolderOnly?: (folderOnly: boolean) => void;
  /** Initial grouping mode (default "recent"). Read once on construction. */
  getInitialGroupMode?: () => GroupMode;
  /** Persist the grouping mode whenever it changes. */
  persistGroupMode?: (mode: GroupMode) => void;
  /**
   * Initial floating geometry of the session-preview overlay (size + position +
   * maximized). Read once on construction to restore the user's last layout
   * across reloads / restarts. Absent / null → auto-anchor to the row on open.
   */
  getInitialPreviewGeometry?: () => VaultPreviewGeometry | null;
  /**
   * Persist the preview overlay geometry whenever the user drags / resizes /
   * maximizes it (or `null` is never sent — geometry only grows once set). Wired
   * to `WebviewStateStore.updateState({ vaultPreviewGeometry })` in main.ts.
   */
  persistPreviewGeometry?: (geometry: VaultPreviewGeometry) => void;
  /**
   * Resolve the active terminal pane's CURRENT cwd on demand (live, OSC 7
   * tracked). Pulled on every render so "This folder only" reflects where the
   * focused terminal is right now — not a value captured before OSC 7 fired
   * (e.g. the user opening the vault and toggling the filter on a shell that
   * had already `cd`'d). Falls back to the pushed `setContextCwd` value in
   * tests where this getter is absent.
   */
  getContextCwd?: () => string | null;
  /**
   * Run the collapse animation around the visual state change. Receives an
   * `apply` callback that performs the actual class toggle; the implementation
   * (in `main.ts`) FLIP-animates the shared `#aux-region` in pixels so the
   * file tree (the in-region grow-sibling) doesn't bounce. Called only on
   * user-initiated toggles; the constructor seed applies the change directly.
   * When absent (tests), the change is applied synchronously with no animation.
   */
  animateCollapse?: (apply: () => void) => void;
}

/** True iff `child` equals `parent` or sits inside its subtree (either separator). */
function isWithin(child: string, parent: string): boolean {
  if (!child || !parent) {
    return false;
  }
  // Strip trailing separators so a trailing-slash parent (`/a/b/`) and a root
  // (`/`) compare correctly without falling into the sibling-prefix trap
  // (`/a/b` must NOT match `/a/bc`). A parent that normalizes to empty was a
  // filesystem root → it contains every absolute path.
  const strip = (p: string): string => p.replace(/[/\\]+$/, "");
  const c = strip(child);
  const p = strip(parent);
  if (p === "") {
    return true;
  }
  return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`);
}

function agentLabel(agent: string): string {
  return getAgentDisplayName(agent) ?? agent;
}

/** "just now" / "5m" / "3h" / "2d" / "Jan 5" — compact relative age. */
function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  const diff = now - epochMs;
  if (!Number.isFinite(epochMs) || epochMs <= 0 || diff < 0) {
    return "";
  }
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) {
    return "just now";
  }
  if (diff < hour) {
    return `${Math.floor(diff / min)}m ago`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}h ago`;
  }
  if (diff < 7 * day) {
    return `${Math.floor(diff / day)}d ago`;
  }
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export class VaultPanel {
  private readonly host: HTMLElement;
  private readonly postMessage: VaultPanelPostMessage;

  private readonly headerEl: HTMLElement;
  private readonly headerMainEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchBarEl: HTMLElement;
  private readonly searchBtnEl: HTMLButtonElement;
  private readonly refreshBtnEl: HTMLButtonElement;
  /** Safety timer that clears the refresh spinner if no fresh response arrives
   *  (e.g. the host hit an error and only logged it). */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly folderToggleEl: HTMLLabelElement;
  private readonly folderCheckboxEl: HTMLInputElement;
  private readonly segmentedEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly persistCollapsed?: (collapsed: boolean) => void;
  private readonly persistFolderOnly?: (folderOnly: boolean) => void;
  private readonly persistGroupMode?: (mode: GroupMode) => void;
  private readonly persistPreviewGeometry?: (geometry: VaultPreviewGeometry) => void;
  private readonly getContextCwd?: () => string | null;
  private readonly animateCollapse?: (apply: () => void) => void;

  private entries: VaultSessionEntry[] = [];
  /** Signature of the entries last painted to the DOM. A response whose signature
   *  matches skips the re-render (cache-vault-load D6) so the cache→fresh refresh
   *  is invisible when nothing changed, preserving an open preview + scroll. */
  private lastRenderSig: string | null = null;
  private query = "";
  private collapsed = true;
  /** Whether the inline header search is open. Transient — never persisted. */
  private searchActive = false;
  /** "This folder only" filter — scope the list to `contextCwd` when on. */
  private folderOnly = false;
  /** Grouping mode for the list (client-side, persisted). */
  private groupMode: GroupMode = "recent";
  /** Collapsed group keys (`<mode>:<key>`) — Agent and Folder groups both
   *  collapse; mode-prefixed so an agent id can't clash with a folder cwd. */
  private readonly collapsedGroups = new Set<string>();
  /** Group keys the user has expanded past the per-group row cap ("Show more"). */
  private readonly expandedGroups = new Set<string>();
  /** Active terminal pane's cwd; the folder filter scopes to this. */
  private contextCwd: string | null = null;
  /** Open right-click context menu (at most one), its anchor row, and listeners. */
  private contextMenuEl: HTMLElement | null = null;
  private contextMenuRow: HTMLElement | null = null;
  private onDocPointerDown?: (ev: MouseEvent) => void;
  private onDocKeyDown?: (ev: KeyboardEvent) => void;
  /** Floating session-preview overlay state (at most one open). */
  private readonly previewEl: HTMLElement;
  /** The entry id whose detail the open preview is for — stale responses (≠ this) are dropped. */
  private activePreviewEntryId: string | null = null;
  private activePreviewEntry: VaultSessionEntry | null = null;
  private activePreviewRow: HTMLElement | null = null;
  /** Tears down an in-flight resize drag (document listeners + pointer capture)
   *  WITHOUT committing its geometry. Invoked by closePreview so an Esc /
   *  click-outside mid-drag can't leak listeners or persist a half-dragged
   *  size (W5). Undefined when no drag is active. */
  private cancelActiveResize?: () => void;
  /** Whether the preview is expanded to fill the whole webview viewport. */
  private previewMaximized = false;
  /** Remembered floating size+position (survives close→reopen). Null until the
   *  user resizes / maximizes; until then each open auto-anchors to the row. */
  private previewGeometry: { top: number; left: number; width: number; height: number } | null = null;
  /** The detail currently shown — kept so "show more" can re-render in place. */
  private activePreviewDetail: VaultSessionDetail | null = null;
  /** Keys (`<prefix>#<runIndex>`) of AI-runs the user expanded past the per-run
   *  cap. Prefixed by container ("root" or a nested entryId) so a nested run's
   *  expansion never collides with a root run. Reset per open. */
  private readonly expandedRuns = new Set<string>();
  /** Dispose fns for the custom tooltips on the preview header's icon buttons.
   *  The header is rebuilt on every preview render, so these are torn down and
   *  re-attached each build (and on close) to avoid leaking listeners. */
  private readonly previewTooltipDisposers: Array<() => void> = [];
  /** Timeline-item limit for the open preview (grows when older msgs are loaded). */
  private previewLimit = PREVIEW_LIMIT_DEFAULT;
  /** True while a load-more request is in flight (debounces the scroll trigger). */
  private previewLoadingMore = false;
  /**
   * Scroll-FAB transient state. The cluster is hidden by default and only
   * revealed for a short window after a scroll (or while the pointer is on it).
   */
  private previewScrollActive = false;
  private previewScrollHovering = false;
  private previewScrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set while a "scroll to top" gesture is loading every older window so it can
   * land on the session's true FIRST message (not just the first one currently
   * rendered). Cleared on the final untruncated render or when the preview closes.
   */
  private previewScrollToTopPending = false;
  /**
   * Timeline length seen on the previous load-all step. When a `truncated`
   * response stops growing it (the host clamps detail limits at MAX_DETAIL_LIMIT),
   * the load-all loop terminates instead of requesting forever for sessions
   * larger than the cap.
   */
  private previewScrollToTopLastCount = 0;
  /** Nested sub-session (subagent) expansion state — keyed by child entryId.
   *  `expandedNested` survives root re-renders; `nestedDetails` caches fetched
   *  child transcripts; `pendingNested` routes an in-flight detail response to
   *  its block. All reset when the preview closes. */
  private readonly expandedNested = new Set<string>();
  private readonly nestedDetails = new Map<string, VaultSessionDetail>();
  private readonly pendingNested = new Map<string, HTMLElement>();
  /** Edge/corner drag handles for resizing the preview (re-attached each render). */
  private readonly resizeHandles: HTMLElement[];
  /**
   * Floating scroll-to-top / scroll-to-bottom cluster pinned to the preview's
   * bottom-right. Each button auto-hides at its edge (top hides at the top,
   * bottom hides at the bottom). Re-attached on every render like the resize
   * handles; its scroll listener is rebound to the fresh `.vault-preview-body`.
   */
  private readonly previewScrollNav: HTMLElement;
  private readonly previewScrollTopBtn: HTMLButtonElement;
  private readonly previewScrollBottomBtn: HTMLButtonElement;
  private onPreviewDocPointerDown?: (ev: MouseEvent) => void;
  private onPreviewDocKeyDown?: (ev: KeyboardEvent) => void;

  constructor(deps: VaultPanelDeps) {
    this.host = deps.host;
    this.postMessage = deps.postMessage;
    this.persistCollapsed = deps.persistCollapsed;
    this.persistFolderOnly = deps.persistFolderOnly;
    this.persistGroupMode = deps.persistGroupMode;
    this.persistPreviewGeometry = deps.persistPreviewGeometry;
    this.getContextCwd = deps.getContextCwd;
    this.animateCollapse = deps.animateCollapse;
    this.groupMode = deps.getInitialGroupMode?.() ?? "recent";

    // Restore the preview overlay's last floating geometry + maximized state so
    // its size/position survive reloads and restarts (auto-anchors when absent).
    const seededGeometry = deps.getInitialPreviewGeometry?.() ?? null;
    if (seededGeometry) {
      this.previewGeometry = {
        top: seededGeometry.top,
        left: seededGeometry.left,
        width: seededGeometry.width,
        height: seededGeometry.height,
      };
      this.previewMaximized = seededGeometry.maximized === true;
    }

    this.host.classList.add("vault-panel");
    this.host.replaceChildren();

    // Header doubles as the collapse toggle (chevron + title + session count).
    // In search mode the title row is swapped for an inline input — the search
    // button toggles it (file-tree header parity); the input is hidden until then.
    const header = document.createElement("div");
    header.className = "vault-header";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-label", "Toggle AI Vault");
    header.setAttribute("aria-expanded", "false");

    const mainRow = document.createElement("div");
    mainRow.className = "vault-header__main";

    const chevron = document.createElement("span");
    chevron.className = "vault-header__chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");

    const title = document.createElement("span");
    title.className = "vault-title";
    title.textContent = "AI Vault";

    this.countEl = document.createElement("span");
    this.countEl.className = "vault-header__count";

    mainRow.append(chevron, title, this.countEl);
    this.headerMainEl = mainRow;

    const toggle = () => this.toggleCollapsed();
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (ev) => {
      if (this.searchActive) {
        return; // search input owns the keyboard while open
      }
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    });
    this.headerEl = header;

    // Inline search bar — lives in the header, hidden until the button is
    // clicked. Clicks/keys inside must not bubble to the collapse toggle.
    const searchBar = document.createElement("div");
    searchBar.className = "vault-header__search";
    searchBar.style.display = "none";
    searchBar.addEventListener("click", (ev) => ev.stopPropagation());
    const searchIcon = document.createElement("span");
    searchIcon.className = "vault-search-icon";
    searchIcon.innerHTML = ICON_SEARCH;
    searchIcon.setAttribute("aria-hidden", "true");
    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.className = "vault-search-input";
    this.searchInput.placeholder = "Search sessions…";
    this.searchInput.setAttribute("aria-label", "Search sessions");
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });
    this.searchInput.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.exitSearch({ focusButton: true });
      }
    });
    searchBar.append(searchIcon, this.searchInput);
    this.searchBarEl = searchBar;

    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "vault-header__search-btn";
    searchBtn.innerHTML = ICON_SEARCH;
    searchBtn.setAttribute("aria-label", "Search sessions");
    searchBtn.addEventListener("click", (ev) => {
      ev.stopPropagation(); // don't toggle the panel collapse
      this.toggleSearch();
    });
    this.searchBtnEl = searchBtn;

    // Manual refresh — re-reads the agents' stores now. Covers the case the
    // auto-refresh-on-reveal (main.ts onViewShow) misses: the vault is open AND
    // visible while an agent writes in a terminal in the same view (no viewShow,
    // no cwd change). stopPropagation so the click doesn't toggle the collapse.
    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "vault-header__refresh-btn";
    refreshBtn.innerHTML = ICON_REFRESH;
    refreshBtn.setAttribute("aria-label", "Refresh sessions");
    refreshBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.setRefreshing(true);
      this.requestRefresh();
    });
    this.refreshBtnEl = refreshBtn;

    header.append(mainRow, searchBar, refreshBtn, searchBtn);

    // Reliable hover/focus tooltips — native `title` doesn't render dependably in
    // VSCode webviews (see fileTree/Tooltip). `getText` for search so the hint
    // tracks the open/close toggle WITHOUT a `title` attribute that would
    // reintroduce the native tooltip. No dispose: the panel lives for the webview's
    // lifetime (unlike FileTreePanel, it is never rebuilt), so listeners aren't leaked.
    attachTooltip(searchBtn, {
      getText: () => (this.searchActive ? "Close search" : "Search sessions by title, folder, or agent"),
    });
    attachTooltip(refreshBtn, { text: "Refresh — re-read sessions from disk now" });

    // Toolbar: grouping segmented control (left) + "This folder only" (right).
    const toolbar = document.createElement("div");
    toolbar.className = "vault-toolbar";
    this.segmentedEl = document.createElement("div");
    this.segmentedEl.className = "vault-segmented";
    this.segmentedEl.setAttribute("role", "tablist");
    this.segmentedEl.setAttribute("aria-label", "Group by");
    for (const [mode, label, icon, hint] of [
      ["recent", "Recent", ICON_RECENT, "Group by most recently used"],
      ["agent", "Agent", ICON_AGENT, "Group by agent (Claude / Codex / OpenCode)"],
      ["folder", "Folder", ICON_FOLDER, "Group by working folder"],
    ] as const) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.mode = mode;
      btn.title = hint;
      btn.setAttribute("role", "tab");
      const iconSpan = document.createElement("span");
      iconSpan.className = "vault-segmented-icon";
      iconSpan.innerHTML = icon;
      iconSpan.setAttribute("aria-hidden", "true");
      const labelSpan = document.createElement("span");
      labelSpan.textContent = label;
      btn.append(iconSpan, labelSpan);
      btn.addEventListener("click", () => this.setGroupMode(mode));
      this.segmentedEl.appendChild(btn);
    }
    toolbar.appendChild(this.segmentedEl);

    // "This folder only" — a checkbox; when checked, scope the list to the
    // active terminal pane's cwd.
    this.folderToggleEl = document.createElement("label");
    this.folderToggleEl.className = "vault-folder-toggle";
    this.folderCheckboxEl = document.createElement("input");
    this.folderCheckboxEl.type = "checkbox";
    this.folderCheckboxEl.className = "vault-folder-toggle-cb";
    const folderText = document.createElement("span");
    folderText.textContent = "This folder only";
    this.folderToggleEl.append(this.folderCheckboxEl, folderText);
    this.folderCheckboxEl.addEventListener("change", () => this.setFolderOnly(this.folderCheckboxEl.checked));
    toolbar.appendChild(this.folderToggleEl);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "vault-status";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "vault-body";
    this.listEl = document.createElement("div");
    this.listEl.className = "vault-list";
    this.listEl.setAttribute("role", "listbox");
    this.listEl.setAttribute("aria-label", "Sessions");
    this.bodyEl.appendChild(this.listEl);

    // Floating preview overlay — absolutely positioned inside the panel.
    this.previewEl = document.createElement("aside");
    this.previewEl.className = "vault-preview";
    this.previewEl.setAttribute("aria-label", "Session preview");
    this.resizeHandles = this.createResizeHandles();
    const scrollNav = this.buildPreviewScrollNav();
    this.previewScrollNav = scrollNav.nav;
    this.previewScrollTopBtn = scrollNav.top;
    this.previewScrollBottomBtn = scrollNav.bottom;

    this.host.append(header, toolbar, this.statusEl, this.bodyEl, this.previewEl);

    // Seed collapsed state (default collapsed) — reconciles the HTML's
    // `vault-collapsed` default with any persisted preference.
    this.setCollapsed(deps.getInitialCollapsed?.() ?? true, { persist: false });
    this.setFolderOnly(deps.getInitialFolderOnly?.() ?? false, { persist: false });
    this.syncSegmented();
  }

  /** Set the grouping mode (segmented control). Persists unless seeding. */
  setGroupMode(mode: GroupMode, opts: { persist?: boolean } = {}): void {
    if (mode === this.groupMode) {
      return;
    }
    this.groupMode = mode;
    this.syncSegmented();
    if (opts.persist !== false) {
      this.persistGroupMode?.(mode);
    }
    this.renderList();
  }

  private syncSegmented(): void {
    // role="tab" → active state is communicated via aria-selected, not aria-pressed (W7).
    for (const btn of Array.from(this.segmentedEl.querySelectorAll<HTMLButtonElement>("button"))) {
      btn.setAttribute("aria-selected", btn.dataset.mode === this.groupMode ? "true" : "false");
    }
  }

  /** Whether the vault section is collapsed to its header strip. */
  isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Whether the "This folder only" filter is active (gates the cwd re-query). */
  isFolderOnly(): boolean {
    return this.folderOnly;
  }

  /** Collapse/expand the section. Persists unless `persist: false`. */
  setCollapsed(collapsed: boolean, opts: { persist?: boolean } = {}): void {
    const wasCollapsed = this.collapsed;
    this.collapsed = collapsed;
    // The class toggle is what changes the flex layout; the animator FLIPs the
    // region around it (pixel basis, no grow tween → the file tree doesn't
    // bounce). User-initiated toggles animate; the constructor seed (persist:
    // false) and the no-animator case (tests) apply the change instantly.
    const applyVisual = (): void => {
      this.host.classList.toggle("vault-collapsed", collapsed);
    };
    if (collapsed !== wasCollapsed && opts.persist !== false && this.animateCollapse) {
      this.animateCollapse(applyVisual);
    } else {
      applyVisual();
    }
    this.headerEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (opts.persist !== false) {
      this.persistCollapsed?.(collapsed);
    }
    // Becoming visible → re-read the session list (the agents' on-disk files
    // are the source of truth, D2; matches the "refresh on open" spec). Only
    // on the collapsed→expanded transition so re-collapsing doesn't fetch and
    // an already-open panel isn't re-fetched on a no-op.
    if (!collapsed && wasCollapsed) {
      // Drop the render-guard key so the first response after re-expand always
      // paints, rather than being skipped as "unchanged" against a pre-collapse
      // signature (the list DOM may have been cleared/altered while hidden).
      this.lastRenderSig = null;
      this.requestRefresh();
    }
  }

  /** Toggle collapsed state (header click / file-tree toolbar button). */
  toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed);
  }

  /** Expand the section if collapsed (the `openVault` command path). */
  expand(): void {
    if (this.collapsed) {
      this.setCollapsed(false);
    }
  }

  /** Header search button: open the inline search, or close it if already open. */
  private toggleSearch(): void {
    if (this.searchActive) {
      this.exitSearch({ focusButton: true });
    } else {
      this.enterSearch();
    }
  }

  /**
   * Open the inline header search: expand the panel if collapsed, swap the
   * title row for the input, and focus it. Mirrors the file-tree header search.
   */
  private enterSearch(): void {
    if (this.searchActive) {
      return;
    }
    if (this.collapsed) {
      this.setCollapsed(false);
    }
    this.searchActive = true;
    this.headerEl.classList.add("is-searching");
    this.headerMainEl.style.display = "none";
    this.searchBarEl.style.display = "flex";
    this.searchBtnEl.innerHTML = ICON_CLOSE;
    this.searchBtnEl.setAttribute("aria-label", "Close search");
    this.searchInput.value = "";
    this.searchInput.focus();
  }

  /** Close the inline search: restore the title row and clear any active query. */
  private exitSearch(opts: { focusButton?: boolean } = {}): void {
    if (!this.searchActive) {
      return;
    }
    this.searchActive = false;
    this.headerEl.classList.remove("is-searching");
    this.searchBarEl.style.display = "none";
    this.headerMainEl.style.display = "";
    this.searchBtnEl.innerHTML = ICON_SEARCH;
    this.searchBtnEl.setAttribute("aria-label", "Search sessions");
    this.searchInput.value = "";
    if (this.query) {
      this.query = "";
      this.renderList();
    }
    if (opts.focusButton) {
      this.searchBtnEl.focus();
    }
  }

  /**
   * Update the active terminal pane's cwd that the "This folder only" filter
   * scopes to. Re-renders only when the filter is on (otherwise nothing visible
   * changes). Called when the user selects a different pane / switches tabs.
   */
  setContextCwd(cwd: string | null): void {
    if (cwd === this.contextCwd) {
      return;
    }
    this.contextCwd = cwd;
    this.syncFolderToggleTitle();
    if (this.folderOnly) {
      this.renderList();
    }
  }

  /** Toggle the "This folder only" filter (the search-row toggle button). */
  toggleFolderOnly(): void {
    this.setFolderOnly(!this.folderOnly);
  }

  /** Set the "This folder only" filter. Persists unless `persist: false`. */
  setFolderOnly(folderOnly: boolean, opts: { persist?: boolean } = {}): void {
    this.folderOnly = folderOnly;
    this.folderCheckboxEl.checked = folderOnly;
    this.folderToggleEl.classList.toggle("is-active", folderOnly);
    this.syncFolderToggleTitle();
    if (opts.persist !== false) {
      this.persistFolderOnly?.(folderOnly);
    }
    this.renderList();
  }

  private syncFolderToggleTitle(): void {
    this.folderToggleEl.title =
      this.folderOnly && this.contextCwd
        ? `Showing sessions in ${this.contextCwd}`
        : "Show only sessions in the active terminal's folder";
  }

  /** Ask the host to (re-)read the agents' session stores. */
  requestRefresh(): void {
    this.postMessage({ type: "requestVaultSessions" });
  }

  /**
   * Toggle the manual-refresh spinner. Spinning is purely a click affordance for
   * the header refresh button (other refresh triggers — expand, viewShow, cwd
   * change — don't spin). A safety timer clears it if no fresh response ever
   * arrives (the host hit an error and only logged it, leaving the cache shown).
   */
  private setRefreshing(on: boolean): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.refreshBtnEl.classList.toggle("is-refreshing", on);
    this.refreshBtnEl.setAttribute("aria-busy", on ? "true" : "false");
    if (on) {
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.refreshBtnEl.classList.remove("is-refreshing");
        this.refreshBtnEl.setAttribute("aria-busy", "false");
      }, 4000);
    }
  }

  /**
   * Render the aggregated result; preserves the current search query. `this.entries`
   * is ALWAYS updated (so client-side search/filter never operate on stale data),
   * but the DOM re-render is skipped when the entries are equivalent to what is
   * already painted (cache-vault-load D6) — the common case for the cache→fresh
   * refresh — so an open preview, scroll position, and selection are undisturbed.
   */
  render(result: VaultListResult, fromCache = false): void {
    // The authoritative (non-cache) response completes a manual refresh — stop the
    // spinner here, BEFORE the no-op guard, so it clears even when nothing changed.
    if (!fromCache) {
      this.setRefreshing(false);
    }
    this.entries = result.entries;
    // Keep the open preview's entry reference live even when the DOM re-render is
    // skipped below — preview re-render paths (e.g. "show more steps") read
    // `activePreviewEntry` directly, so a skipped render must not leave it stale.
    if (this.activePreviewEntryId) {
      const fresh = result.entries.find((e) => e.id === this.activePreviewEntryId);
      if (fresh) {
        this.activePreviewEntry = fresh;
      }
    }
    // Guard on the full rendered projection (entries + the live filter state
    // renderList consumes). renderList() updates lastRenderSig to match what it
    // actually painted, so a render triggered by a LOCAL UI change (search /
    // folder toggle / group mode, which call renderList directly) also refreshes
    // the key — a later unchanged host response then correctly no-ops instead of
    // rebuilding the DOM and disturbing scroll + the open preview (D6).
    if (this.currentSignature() === this.lastRenderSig) {
      return;
    }
    this.renderList();
  }

  /** Signature of the full rendered projection: entries + every input renderList
   *  consumes (search query, folder-only + the live context cwd it re-pulls,
   *  group mode). Read by the render() no-op guard; stored by renderList() so the
   *  key always reflects what is actually on screen (cache-vault-load D6). */
  private currentSignature(): string {
    const liveCwd = this.getContextCwd ? this.getContextCwd() : this.contextCwd;
    return JSON.stringify([
      entriesSignature(this.entries),
      this.query,
      this.folderOnly,
      liveCwd ?? null,
      this.groupMode,
    ]);
  }

  private matchesQuery(entry: VaultSessionEntry): boolean {
    if (!this.query) {
      return true;
    }
    return (
      entry.title.toLowerCase().includes(this.query) ||
      entry.cwd.toLowerCase().includes(this.query) ||
      agentLabel(entry.agent).toLowerCase().includes(this.query) ||
      entry.agent.toLowerCase().includes(this.query)
    );
  }

  /** When "This folder only" is on, scope to the active pane's cwd subtree. */
  private matchesFolder(entry: VaultSessionEntry): boolean {
    if (!this.folderOnly || !this.contextCwd) {
      return true;
    }
    return isWithin(entry.cwd, this.contextCwd);
  }

  private renderStatus(visibleCount: number): void {
    this.statusEl.replaceChildren();

    if (this.entries.length === 0) {
      this.statusEl.appendChild(
        emptyState(ICON_ARCHIVE, "No AI sessions yet", "Sessions appear here after you run an AI agent in a terminal."),
      );
    } else if (visibleCount === 0) {
      // Distinct no-match state (NOT the empty state) — actionable hint.
      const body =
        this.folderOnly && this.contextCwd && !this.query
          ? "No sessions in this folder. Turn off the This folder filter to see all."
          : "Try a shorter query or clear the This folder filter.";
      this.statusEl.appendChild(emptyState(ICON_SEARCH, "No matching sessions", body));
    }
  }

  private renderList(): void {
    // Pull the freshest active-pane cwd before filtering so "This folder only"
    // reflects where the focused terminal is NOW. The pushed `setContextCwd`
    // value is captured at mount / pane-change, which can be null if OSC 7
    // hadn't fired yet — without this live pull the toggle is a no-op (the
    // filter falls through to "show all" on a null contextCwd).
    if (this.getContextCwd) {
      this.contextCwd = this.getContextCwd();
      this.syncFolderToggleTitle();
    }
    const visible = this.entries.filter((e) => this.matchesFolder(e) && this.matchesQuery(e));
    // The badge reflects what the list actually shows (folder + search scoped),
    // not the unfiltered total — otherwise it over-reports under an active
    // filter. See .reviews/round-2.md [W2].
    this.countEl.textContent = visible.length > 0 ? String(visible.length) : "";
    this.renderStatus(visible.length);

    this.listEl.replaceChildren();
    // Recent → flat list (no group headers). Agent/Folder → grouped headers.
    for (const group of groupEntries(visible, this.groupMode)) {
      if (group.mode !== "recent") {
        const collapsed = this.collapsedGroups.has(`${group.mode}:${group.key}`);
        this.listEl.appendChild(
          this.renderGroupHeader(group.mode, group.key, group.label, group.entries.length, collapsed),
        );
        if (collapsed) {
          continue; // group collapsed → skip its rows
        }
      }
      // Cap each group at MAX_VISIBLE_PER_GROUP rows; the rest hide behind a
      // "Show N more" button (per group, so one busy agent/folder can't bury
      // the others). Newest-first ordering means the cap keeps the most recent.
      const expanded = this.expandedGroups.has(group.key);
      const overflow = group.entries.length - MAX_VISIBLE_PER_GROUP;
      const shown = expanded || overflow <= 0 ? group.entries : group.entries.slice(0, MAX_VISIBLE_PER_GROUP);
      for (const entry of shown) {
        this.listEl.appendChild(this.renderRow(entry, { hideCwd: group.hideCwd }));
      }
      if (!expanded && overflow > 0) {
        this.listEl.appendChild(this.renderShowMore(group.key, overflow));
      }
    }

    // A re-render (group/filter/search change or a host push) rebuilds every row,
    // so the open preview's selection highlight lands on a now-detached node. Re-
    // apply it to the fresh row so the preview stays anchored to its source (W4).
    // If that row is no longer visible (filtered out / collapsed / behind "show
    // more"), clear the stale ref — the preview stays open, just unanchored.
    if (this.activePreviewEntryId) {
      // Match on dataset rather than a `[data-entry-id="…"]` selector so an
      // entryId's `:` separator needs no CSS escaping (and no CSS.escape dep).
      const row =
        Array.from(this.listEl.querySelectorAll<HTMLElement>(".vault-row")).find(
          (r) => r.dataset.entryId === this.activePreviewEntryId,
        ) ?? null;
      this.activePreviewRow = row;
      row?.setAttribute("aria-selected", "true");
    }

    // Record what we just painted so the render() guard compares host responses
    // against the ACTUAL DOM projection — including renders triggered by local UI
    // changes (search/filter/group), which call renderList directly.
    this.lastRenderSig = this.currentSignature();
  }

  /** "Show N more" affordance that expands a group past the per-group cap. */
  private renderShowMore(key: string, hidden: number): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vault-show-more";
    btn.textContent = `Show ${hidden} more`;
    btn.addEventListener("click", () => {
      this.expandedGroups.add(key);
      this.renderList();
    });
    return btn;
  }

  private renderGroupHeader(
    mode: GroupMode,
    key: string,
    label: string,
    count: number,
    collapsed: boolean,
  ): HTMLElement {
    const header = document.createElement("div");
    header.className = "vault-group-header";
    if (collapsed) {
      header.classList.add("is-collapsed");
    }
    // Both Agent and Folder groups collapse: a leading chevron rotates with the
    // state and the whole header toggles it (the row cap "Show more" is separate).
    const chevron = document.createElement("span");
    chevron.className = "vault-group-chevron";
    chevron.innerHTML = ICON_CHEVRON_DOWN;
    chevron.setAttribute("aria-hidden", "true");
    header.appendChild(chevron);
    if (mode === "agent") {
      // The agent's real brand icon (key is the agent id). SVG comes ONLY from
      // the closed agent-icon map (never session data) → safe innerHTML (D1).
      const badge = document.createElement("span");
      badge.className = "vault-badge vault-group-badge";
      const icon = getAgentIcon(key);
      if (icon) {
        badge.classList.add(`vault-badge--${icon.accent}`);
        badge.innerHTML = icon.svg;
      } else {
        badge.textContent = label.slice(0, 2);
      }
      header.appendChild(badge);
    } else {
      header.classList.add("vault-group-header--folder");
      const folderIcon = document.createElement("span");
      folderIcon.className = "vault-group-icon";
      folderIcon.innerHTML = ICON_FOLDER;
      header.appendChild(folderIcon);
    }
    const labelEl = document.createElement("span");
    labelEl.className = "vault-group-label";
    labelEl.textContent = label;
    const countEl = document.createElement("span");
    countEl.className = "vault-group-count";
    countEl.textContent = `· ${count}`;
    header.append(labelEl, countEl);
    // Interactive toggle: clickable + keyboard-operable, state announced.
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    header.title = collapsed ? `Expand ${label}` : `Collapse ${label}`;
    header.addEventListener("click", () => this.toggleGroup(mode, key));
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleGroup(mode, key);
      }
    });
    return header;
  }

  private toggleGroup(mode: GroupMode, key: string): void {
    const groupKey = `${mode}:${key}`;
    if (this.collapsedGroups.has(groupKey)) {
      this.collapsedGroups.delete(groupKey);
    } else {
      this.collapsedGroups.add(groupKey);
    }
    this.renderList();
  }

  /**
   * Open the right-click context menu for a row, anchored at the cursor and
   * clamped within the panel. The file-targeting items (Open / Reveal / Copy
   * File Path) appear only when the session is file-backed (`sessionPath`).
   * Every item posts an `entryId`-only message — the webview sends no path (D9).
   */
  private openContextMenu(entry: VaultSessionEntry, ev: MouseEvent, row: HTMLElement): void {
    this.closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "vault-context-menu";
    menu.setAttribute("role", "menu");

    const fileBacked = typeof entry.sessionPath === "string" && entry.sessionPath.length > 0;
    type MenuItem = { label: string; icon: string; fileOnly?: boolean; act: () => void };
    const items: (MenuItem | "sep")[] = [
      {
        label: "Resume in New Tab",
        icon: ICON_RESUME,
        act: () => this.postMessage({ type: "vaultResume", entryId: entry.id }),
      },
      "sep",
      {
        label: "Open",
        icon: ICON_OPEN,
        fileOnly: true,
        act: () => this.postMessage({ type: "vaultOpenSessionFile", entryId: entry.id }),
      },
      {
        label: "Reveal in Finder",
        icon: ICON_REVEAL,
        fileOnly: true,
        act: () => this.postMessage({ type: "vaultRevealInOS", entryId: entry.id }),
      },
      "sep",
      {
        label: "Copy File Path",
        icon: ICON_COPY,
        fileOnly: true,
        act: () => this.postMessage({ type: "vaultCopyFilePath", entryId: entry.id }),
      },
      {
        label: "Copy Resume Command",
        icon: ICON_TERMINAL,
        act: () => this.postMessage({ type: "vaultCopyResumeCommand", entryId: entry.id }),
      },
      {
        label: "Open Working Directory",
        icon: ICON_FOLDER,
        act: () => this.postMessage({ type: "vaultOpenWorkingDir", entryId: entry.id }),
      },
    ];
    const visible = collapseSeparators(items.filter((it) => it === "sep" || !it.fileOnly || fileBacked));
    for (const it of visible) {
      if (it === "sep") {
        menu.appendChild(document.createElement("hr"));
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      const iconSpan = document.createElement("span");
      iconSpan.innerHTML = it.icon;
      iconSpan.setAttribute("aria-hidden", "true");
      const labelSpan = document.createElement("span");
      labelSpan.textContent = it.label;
      btn.append(iconSpan, labelSpan);
      btn.addEventListener("click", () => {
        it.act();
        this.closeContextMenu();
      });
      menu.appendChild(btn);
    }

    this.host.appendChild(menu);

    // Position relative to the panel (it is `position: relative`), clamped in.
    const rect = this.host.getBoundingClientRect();
    let left = ev.clientX - rect.left;
    let top = ev.clientY - rect.top;
    const maxLeft = this.host.clientWidth - menu.offsetWidth - 4;
    const maxTop = this.host.clientHeight - menu.offsetHeight - 4;
    if (maxLeft > 0 && left > maxLeft) {
      left = maxLeft;
    }
    if (maxTop > 0 && top > maxTop) {
      top = maxTop;
    }
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;

    this.contextMenuEl = menu;
    this.contextMenuRow = row;
    row.classList.add("is-context-open");

    // The opening event is a `contextmenu`, so attaching mousedown/keydown now
    // won't self-close. Close on Esc or any pointer-down outside the menu.
    this.onDocPointerDown = (e) => {
      if (this.contextMenuEl && !this.contextMenuEl.contains(e.target as Node)) {
        this.closeContextMenu();
      }
    };
    this.onDocKeyDown = (e) => {
      if (e.key === "Escape") {
        this.closeContextMenu();
      }
    };
    document.addEventListener("mousedown", this.onDocPointerDown);
    document.addEventListener("keydown", this.onDocKeyDown);
  }

  private closeContextMenu(): void {
    if (this.onDocPointerDown) {
      document.removeEventListener("mousedown", this.onDocPointerDown);
      this.onDocPointerDown = undefined;
    }
    if (this.onDocKeyDown) {
      document.removeEventListener("keydown", this.onDocKeyDown);
      this.onDocKeyDown = undefined;
    }
    this.contextMenuRow?.classList.remove("is-context-open");
    this.contextMenuRow = null;
    this.contextMenuEl?.remove();
    this.contextMenuEl = null;
  }

  /**
   * Activate a row → open the floating preview in a loading state, anchor it
   * near the row, and request the session's detail on demand. `activePreviewEntryId`
   * is the guard the response handler checks so a slow response for a row the
   * user has since left is dropped (no stale render).
   */
  private openPreview(entry: VaultSessionEntry, row: HTMLElement): void {
    this.closeContextMenu();
    // Clear the prior selection highlight (switching previews without closing).
    this.activePreviewRow?.removeAttribute("aria-selected");

    this.activePreviewEntryId = entry.id;
    this.activePreviewEntry = entry;
    this.activePreviewRow = row;
    this.activePreviewDetail = null;
    this.expandedRuns.clear();
    this.expandedNested.clear();
    this.nestedDetails.clear();
    this.pendingNested.clear();
    this.previewLimit = PREVIEW_LIMIT_DEFAULT;
    this.previewLoadingMore = false;
    this.previewScrollToTopPending = false;
    this.resetPreviewScrollNavState();
    row.setAttribute("aria-selected", "true");

    this.applyPreviewAgentAccent(entry.agent);
    this.renderPreviewLoading(entry);
    this.previewEl.classList.add("is-open");
    this.applyPreviewPlacement(row);
    this.attachPreviewCloseListeners();
    this.postMessage({ type: "requestVaultSessionDetail", entryId: entry.id });
  }

  /** Tint the preview's user messages with the session's agent accent (D: #3). */
  private applyPreviewAgentAccent(agent: string): void {
    // Clear every known accent class (derived, so a new accent is handled too).
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

  /** Place the preview on open: remembered geometry / maximized, else anchor to row. */
  private applyPreviewPlacement(row: HTMLElement): void {
    this.previewEl.classList.toggle("vault-preview--max", this.previewMaximized);
    if (this.previewMaximized) {
      this.clearPreviewInlineGeometry();
      return;
    }
    if (this.previewGeometry) {
      this.applyPreviewGeometry(this.previewGeometry);
    } else {
      this.anchorPreview(row);
    }
  }

  private applyPreviewGeometry(g: { top: number; left: number; width: number; height: number }): void {
    // Clamp into the CURRENT viewport — a geometry saved in a larger window (or
    // before a restart at a different window size) must not place the card
    // off-screen. Mirrors the bounds the resize/move gestures enforce.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(280, g.width), Math.max(280, vw - 16));
    const height = Math.min(Math.max(160, g.height), Math.max(160, vh - 16));
    const left = Math.max(0, Math.min(g.left, Math.max(0, vw - 40)));
    const top = Math.max(0, Math.min(g.top, Math.max(0, vh - 40)));
    this.previewEl.style.right = "auto";
    this.previewEl.style.left = `${left}px`;
    this.previewEl.style.top = `${top}px`;
    this.previewEl.style.width = `${width}px`;
    this.previewEl.style.height = `${height}px`;
  }

  private clearPreviewInlineGeometry(): void {
    this.previewEl.style.top = "";
    this.previewEl.style.left = "";
    this.previewEl.style.right = "";
    this.previewEl.style.width = "";
    this.previewEl.style.height = "";
  }

  /** Snapshot the current floating geometry so it survives close→reopen (#1). */
  private capturePreviewGeometry(): void {
    const r = this.previewEl.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      this.previewGeometry = { top: r.top, left: r.left, width: r.width, height: r.height };
      this.persistPreviewState();
    }
  }

  /**
   * Persist the current floating geometry + maximized flag to durable webview
   * state so it survives reloads / restarts. No-op until a geometry exists.
   */
  private persistPreviewState(): void {
    if (!this.previewGeometry) {
      return;
    }
    this.persistPreviewGeometry?.({ ...this.previewGeometry, maximized: this.previewMaximized });
  }

  private closePreview(): void {
    // Abort an in-flight resize drag first so its document listeners don't
    // outlive the closed preview and overwrite previewGeometry on release (W5).
    this.cancelActiveResize?.();
    this.previewEl.classList.remove("is-open");
    this.previewEl.replaceChildren();
    // Keep previewGeometry + previewMaximized so the next open restores them (#1).
    this.activePreviewEntryId = null;
    this.activePreviewEntry = null;
    this.activePreviewDetail = null;
    this.expandedRuns.clear();
    this.expandedNested.clear();
    this.nestedDetails.clear();
    this.pendingNested.clear();
    this.activePreviewRow?.removeAttribute("aria-selected");
    this.activePreviewRow = null;
    this.previewScrollToTopPending = false;
    this.resetPreviewScrollNavState();
    this.disposePreviewTooltips();
    this.detachPreviewCloseListeners();
  }

  /** Tear down the preview header's custom tooltips (called before each header
   *  rebuild and on close) so their listeners + shared-widget refs don't leak. */
  private disposePreviewTooltips(): void {
    for (const dispose of this.previewTooltipDisposers) {
      dispose();
    }
    this.previewTooltipDisposers.length = 0;
  }

  /** Toggle the preview between its floating size and a full-viewport overlay. */
  private toggleMaximizePreview(): void {
    if (!this.previewMaximized) {
      this.capturePreviewGeometry(); // remember floating size/pos for restore
    }
    this.previewMaximized = !this.previewMaximized;
    this.previewEl.classList.toggle("vault-preview--max", this.previewMaximized);
    const btn = this.previewEl.querySelector<HTMLButtonElement>(".vault-preview-maximize");
    if (this.previewMaximized) {
      this.clearPreviewInlineGeometry(); // let the maximized rule (full viewport) win
      if (btn) {
        // No `.title` here — the custom tooltip (getText) tracks the label; setting
        // `.title` would reintroduce the slow native tooltip alongside it.
        btn.innerHTML = ICON_RESTORE;
        btn.setAttribute("aria-label", "Restore size");
        btn.setAttribute("aria-pressed", "true");
      }
    } else {
      if (btn) {
        btn.innerHTML = ICON_MAXIMIZE;
        btn.setAttribute("aria-label", "Expand to full size");
        btn.setAttribute("aria-pressed", "false");
      }
      if (this.previewGeometry) {
        this.applyPreviewGeometry(this.previewGeometry);
      } else if (this.activePreviewRow) {
        this.anchorPreview(this.activePreviewRow);
      }
    }
    // Persist the new maximized flag (capturePreviewGeometry above only ran in
    // the floating→max direction and recorded maximized=false).
    this.persistPreviewState();
  }

  /** Build the 8 edge/corner resize handles (created once, re-attached per render). */
  private createResizeHandles(): HTMLElement[] {
    const dirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
    return dirs.map((dir) => {
      const h = document.createElement("div");
      h.className = `vault-preview-resize vault-preview-resize-${dir}`;
      h.setAttribute("aria-hidden", "true");
      h.addEventListener("pointerdown", (ev) => this.startResize(ev, dir));
      return h;
    });
  }

  /** Render preview content, keeping the resize handles + scroll nav attached on top. */
  private setPreviewContent(...nodes: Node[]): void {
    this.previewEl.replaceChildren(...nodes, ...this.resizeHandles, this.previewScrollNav);
    this.wirePreviewScrollNav();
  }

  /**
   * Build the floating scroll-to-top / scroll-to-bottom cluster. The container
   * is pointer-transparent; only the visible buttons take pointer events (CSS),
   * so a hidden button never blocks clicks on the transcript behind it. Click
   * handlers re-query the live `.vault-preview-body` so they always act on the
   * current render.
   */
  private buildPreviewScrollNav(): { nav: HTMLElement; top: HTMLButtonElement; bottom: HTMLButtonElement } {
    const nav = document.createElement("div");
    nav.className = "vault-preview-scroll-nav";
    // Keep the cluster alive while the pointer is on it so a fading FAB doesn't
    // slip away just as the user reaches to click it.
    nav.addEventListener("pointerenter", () => {
      this.previewScrollHovering = true;
      if (this.previewScrollIdleTimer) {
        clearTimeout(this.previewScrollIdleTimer);
        this.previewScrollIdleTimer = null;
      }
    });
    nav.addEventListener("pointerleave", () => {
      this.previewScrollHovering = false;
      this.scheduleHidePreviewScrollNav();
    });
    const make = (cls: string, label: string, svg: string, onClick: () => void): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `vault-preview-scroll-btn ${cls}`;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.innerHTML = svg;
      // mousedown.stopPropagation so the preview's outside-click close listener
      // doesn't treat the FAB press as a dismiss.
      btn.addEventListener("mousedown", (e) => e.stopPropagation());
      btn.addEventListener("click", onClick);
      return btn;
    };
    const top = make("vault-preview-scroll-top", "Scroll to first message", ICON_SCROLL_TOP, () =>
      this.scrollPreviewToTop(),
    );
    const bottom = make("vault-preview-scroll-bottom", "Scroll to latest message", ICON_SCROLL_BOTTOM, () =>
      this.smoothScrollPreviewBody("end"),
    );
    nav.append(top, bottom);
    return { nav, top, bottom };
  }

  /**
   * Scroll to the session's FIRST message. The preview is paginated (the newest
   * window is rendered first), so when older messages are still truncated this
   * loads every older window before landing on the true first message — handled
   * incrementally in `handleSessionDetailResponse` via `previewScrollToTopPending`.
   */
  private scrollPreviewToTop(): void {
    if (this.activePreviewDetail?.truncated) {
      this.previewScrollToTopPending = true;
      this.previewScrollToTopLastCount = this.activePreviewDetail.timeline?.length ?? 0;
      this.requestMorePreview();
      return;
    }
    this.smoothScrollPreviewBody(0);
  }

  /** Smooth-scroll the live preview body to the top (0) or its end. */
  private smoothScrollPreviewBody(target: 0 | "end"): void {
    const body = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    if (!body) {
      return;
    }
    body.scrollTo({ top: target === "end" ? body.scrollHeight : 0, behavior: "smooth" });
  }

  /**
   * After each render, (re)bind the scroll listener to the fresh body. The
   * previous body element is discarded by `replaceChildren`, so its listener is
   * collected with it — no leak, no double-bind. The cluster starts hidden and
   * is revealed transiently on scroll. When the body is absent (loading/error
   * placeholder), the whole cluster hides.
   */
  private wirePreviewScrollNav(): void {
    const body = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    if (!body) {
      this.previewScrollNav.classList.add("is-empty");
      return;
    }
    this.previewScrollNav.classList.remove("is-empty");
    this.previewScrollActive = false;
    body.addEventListener("scroll", () => this.revealPreviewScrollNav(body), { passive: true });
    this.updatePreviewScrollNav(body);
  }

  /** Reveal the FABs (subject to edge/scrollable checks) and (re)arm the idle-hide timer. */
  private revealPreviewScrollNav(body: HTMLElement): void {
    this.previewScrollActive = true;
    this.updatePreviewScrollNav(body);
    this.scheduleHidePreviewScrollNav();
  }

  /** Hide the FAB cluster after a short idle period — unless the pointer is on it. */
  private scheduleHidePreviewScrollNav(): void {
    if (this.previewScrollIdleTimer) {
      clearTimeout(this.previewScrollIdleTimer);
      this.previewScrollIdleTimer = null;
    }
    if (this.previewScrollHovering) {
      return;
    }
    this.previewScrollIdleTimer = setTimeout(() => {
      this.previewScrollIdleTimer = null;
      this.previewScrollActive = false;
      const body = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
      if (body) {
        this.updatePreviewScrollNav(body);
      }
    }, 1100);
  }

  /** Clear transient scroll-nav state (timer + flags). Called when the preview reopens/closes. */
  private resetPreviewScrollNavState(): void {
    if (this.previewScrollIdleTimer) {
      clearTimeout(this.previewScrollIdleTimer);
      this.previewScrollIdleTimer = null;
    }
    this.previewScrollActive = false;
    this.previewScrollHovering = false;
    this.previewScrollToTopLastCount = 0;
  }

  /**
   * Toggle each FAB from the body's scroll position. Both stay hidden unless the
   * cluster is currently "active" (recently scrolled / hovered) so the buttons
   * only appear while the user is actually scrolling.
   */
  private updatePreviewScrollNav(body: HTMLElement): void {
    const EDGE = 8;
    const show = this.previewScrollActive && body.scrollHeight - body.clientHeight > EDGE;
    const atTop = body.scrollTop <= EDGE;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= EDGE;
    this.previewScrollTopBtn.classList.toggle("is-visible", show && !atTop);
    this.previewScrollBottomBtn.classList.toggle("is-visible", show && !atBottom);
  }

  /** Drag one edge/corner handle to resize the floating preview (all 4 sides). */
  private startResize(ev: PointerEvent, dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"): void {
    if (this.previewMaximized) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const rect = this.previewEl.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const startL = rect.left;
    const startT = rect.top;
    const minW = 280;
    const minH = 160;
    const handle = ev.currentTarget as HTMLElement;
    handle.setPointerCapture?.(ev.pointerId);
    // Pin via left/top + width/height (clear the default right anchor).
    this.previewEl.style.right = "auto";

    const onMove = (e: PointerEvent): void => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let w = startW;
      let h = startH;
      let l = startL;
      let t = startT;
      if (dir.includes("e")) {
        w = startW + dx;
      }
      if (dir.includes("s")) {
        h = startH + dy;
      }
      if (dir.includes("w")) {
        w = startW - dx;
        l = startL + dx;
      }
      if (dir.includes("n")) {
        h = startH - dy;
        t = startT + dy;
      }
      if (w < minW) {
        if (dir.includes("w")) {
          l = startL + (startW - minW);
        }
        w = minW;
      }
      if (h < minH) {
        if (dir.includes("n")) {
          t = startT + (startH - minH);
        }
        h = minH;
      }
      l = Math.max(0, Math.min(l, window.innerWidth - 40));
      t = Math.max(0, Math.min(t, window.innerHeight - 40));
      this.previewEl.style.left = `${l}px`;
      this.previewEl.style.top = `${t}px`;
      this.previewEl.style.width = `${w}px`;
      this.previewEl.style.height = `${h}px`;
    };
    const teardown = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      handle.releasePointerCapture?.(ev.pointerId);
      this.cancelActiveResize = undefined;
    };
    const onUp = (): void => {
      teardown();
      this.capturePreviewGeometry(); // remember size/pos across close→reopen (#1)
    };
    // Exposed so closePreview can abort a drag in progress (W5) — abort drops the
    // mid-drag geometry (no capturePreviewGeometry), unlike a normal pointerup.
    this.cancelActiveResize = teardown;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /**
   * Drag the preview header to move the floating card (translate left/top, size
   * pinned). Pointer-captured + document-listener driven like `startResize`, so
   * the gesture survives the cursor leaving the (narrow sidebar) iframe. Ignores
   * presses on the action buttons and a plain click (no movement), so the card
   * is only "pinned" once actually dragged.
   */
  private startMove(ev: PointerEvent): void {
    if (this.previewMaximized || ev.button !== 0) {
      return;
    }
    const target = ev.target as Element | null;
    if (target?.closest(".vault-preview-title-actions")) {
      return; // header action buttons keep their own click behaviour
    }
    if (target?.closest(".vault-preview-meta")) {
      return; // the meta block stays selectable (drag works on its padding)
    }
    ev.preventDefault();
    const rect = this.previewEl.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startL = rect.left;
    const startT = rect.top;
    const w = rect.width;
    const h = rect.height;
    const handle = ev.currentTarget as HTMLElement;
    handle.setPointerCapture?.(ev.pointerId);
    this.previewEl.style.right = "auto";
    let moved = false;
    const onMove = (e: PointerEvent): void => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) {
        return; // sub-pixel jitter — a plain click must not pin/persist geometry
      }
      moved = true;
      const l = Math.max(0, Math.min(startL + dx, window.innerWidth - 40));
      const t = Math.max(0, Math.min(startT + dy, window.innerHeight - 40));
      this.previewEl.style.left = `${l}px`;
      this.previewEl.style.top = `${t}px`;
      // Pin the size so the card translates rather than reflowing.
      this.previewEl.style.width = `${w}px`;
      this.previewEl.style.height = `${h}px`;
    };
    const teardown = (): void => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      handle.releasePointerCapture?.(ev.pointerId);
      this.cancelActiveResize = undefined;
    };
    const onUp = (): void => {
      teardown();
      if (moved) {
        this.capturePreviewGeometry(); // remember + persist the new position
      }
    };
    // Reuse the resize abort hook so closePreview can cancel a move mid-drag.
    this.cancelActiveResize = teardown;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /**
   * Host → webview detail reply. Drops a response whose `entryId` is no longer
   * the active preview (the user opened a different row first) — the stale-render
   * guard. Renders the detail, a partial notice, or an inline error.
   */
  handleSessionDetailResponse(msg: VaultSessionDetailResponseMessage): void {
    // Nested sub-session (subagent) reply — render into its expanded block,
    // independent of the root preview's stale-guard / load-more bookkeeping.
    const nestedContainer = this.pendingNested.get(msg.entryId);
    if (nestedContainer) {
      this.pendingNested.delete(msg.entryId);
      if (msg.detail && !msg.error) {
        this.nestedDetails.set(msg.entryId, msg.detail);
        this.renderNestedInto(nestedContainer, msg.detail, msg.entryId);
      } else {
        nestedContainer.textContent = msg.error ?? "Couldn't read this sub-session.";
      }
      return;
    }
    if (msg.entryId !== this.activePreviewEntryId || !this.activePreviewEntry) {
      return; // stale — ignore
    }
    const wasLoadingMore = this.previewLoadingMore;
    this.previewLoadingMore = false;
    if (msg.error || !msg.detail) {
      this.renderPreviewError(this.activePreviewEntry, msg.error ?? "Couldn't read this session.");
      return;
    }
    // On load-more, older items are prepended → keep the viewport anchored to the
    // same content by preserving the distance from the bottom across the re-render.
    const bodyBefore = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    const fromBottom = wasLoadingMore && bodyBefore ? bodyBefore.scrollHeight - bodyBefore.scrollTop : null;
    // A load-more re-render prepends older items to the ROOT timeline, shifting
    // its run indices → drop root run-expansions only. Nested transcripts didn't
    // change, so their `<entryId>#…` expansions stay valid (must not be cleared).
    if (wasLoadingMore) {
      for (const k of this.expandedRuns) {
        if (k.startsWith("root#")) {
          this.expandedRuns.delete(k);
        }
      }
    }
    this.renderPreviewDetail(this.activePreviewEntry, msg.detail);
    if (this.previewScrollToTopPending) {
      // A "scroll to first message" gesture is walking older windows. Keep
      // loading while the timeline still GROWS; stop once it's fully loaded OR
      // the host stops returning more (it clamps detail limits at
      // MAX_DETAIL_LIMIT, so a >cap session stays `truncated` forever — without
      // the growth check this would loop indefinitely). Then jump to the very
      // top (instant — a smooth scroll across the full history would be a long,
      // jarring animation).
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
      this.scrollPreviewToEnd();
    }
  }

  private attachPreviewCloseListeners(): void {
    this.detachPreviewCloseListeners();
    this.onPreviewDocPointerDown = (e) => {
      const target = e.target as Node;
      // Don't close when the click is inside the preview or on a row (a row
      // click opens a different preview, handled by its own listener).
      if (this.previewEl.contains(target) || (target instanceof Element && target.closest(".vault-row"))) {
        return;
      }
      this.closePreview();
    };
    this.onPreviewDocKeyDown = (e) => {
      // When the context menu is also open, let its own Esc handler dismiss only
      // that layer first — one Esc shouldn't close both (W5).
      if (e.key === "Escape" && !this.contextMenuEl) {
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

  /**
   * Anchor the floating preview near the activated row in VIEWPORT coordinates
   * (it is `position: fixed`, so it can extend over the terminal — it is not
   * clipped to the vault panel). Prefers placing the card to the left of the row
   * (over the content area), falling back to the right, then clamps in-viewport.
   */
  private anchorPreview(row: HTMLElement): void {
    if (this.previewMaximized) {
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.previewEl.offsetWidth || 560;
    const h = this.previewEl.offsetHeight || Math.min(Math.round(vh * 0.7), 560);
    let left = rowRect.left - w - 12;
    if (left < 8) {
      left = rowRect.right + 12;
    }
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
    const top = Math.max(8, Math.min(rowRect.top, vh - h - 8));
    this.previewEl.style.right = "auto";
    this.previewEl.style.left = `${left}px`;
    this.previewEl.style.top = `${top}px`;
  }

  /** Header: agent badge + title + Resume + Close + meta block. */
  private buildPreviewHeader(entry: VaultSessionEntry, detail?: VaultSessionDetail): HTMLElement {
    // The header is rebuilt on every preview render — tear down the prior build's
    // custom tooltips before this build attaches new ones (no dangling listeners).
    this.disposePreviewTooltips();
    const header = document.createElement("header");
    header.className = "vault-preview-header";

    // The whole header strip (title row + its padding) is the move handle, so a
    // drag can start anywhere in the header, not just on the title text. The
    // meta block keeps its own behaviour (text stays selectable) via a guard in
    // startMove.
    header.addEventListener("pointerdown", (ev) => this.startMove(ev));

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
    prevBtn.addEventListener("click", () => this.scrollToAdjacentUser(-1));
    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "vault-preview-icon-btn vault-preview-nav-next";
    nextBtn.title = "Jump to next user message";
    nextBtn.setAttribute("aria-label", "Jump to next user message");
    nextBtn.innerHTML = ICON_NAV_NEXT;
    nextBtn.addEventListener("click", () => this.scrollToAdjacentUser(1));
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "vault-preview-resume";
    resumeBtn.title = "Resume session";
    resumeBtn.setAttribute("aria-label", "Resume session");
    resumeBtn.innerHTML = ICON_RESUME;
    resumeBtn.addEventListener("click", () => this.postMessage({ type: "vaultResume", entryId: entry.id }));
    const maximizeBtn = document.createElement("button");
    maximizeBtn.type = "button";
    maximizeBtn.className = "vault-preview-icon-btn vault-preview-maximize";
    const maxLabel = this.previewMaximized ? "Restore size" : "Expand to full size";
    maximizeBtn.title = maxLabel;
    maximizeBtn.setAttribute("aria-label", maxLabel);
    maximizeBtn.setAttribute("aria-pressed", this.previewMaximized ? "true" : "false");
    maximizeBtn.innerHTML = this.previewMaximized ? ICON_RESTORE : ICON_MAXIMIZE;
    maximizeBtn.addEventListener("click", () => this.toggleMaximizePreview());
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "vault-preview-icon-btn vault-preview-close";
    closeBtn.title = "Close preview";
    closeBtn.setAttribute("aria-label", "Close preview");
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener("click", () => this.closePreview());
    actions.append(prevBtn, nextBtn, resumeBtn, maximizeBtn, closeBtn);
    // Custom hover tooltips (fast, body-mounted) replace native `title`, which is
    // slow + unreliable in webviews (the icon SVG also swallows the native title's
    // hover target). `attachTooltip` reads + strips each `.title`. Maximize uses
    // `getText` because its label flips with state — re-setting `.title` later
    // (toggleMaximizePreview) would otherwise reintroduce the native tooltip.
    this.previewTooltipDisposers.push(
      attachTooltip(prevBtn),
      attachTooltip(nextBtn),
      attachTooltip(resumeBtn),
      attachTooltip(maximizeBtn, {
        getText: () => (this.previewMaximized ? "Restore size" : "Expand to full size"),
      }),
      attachTooltip(closeBtn),
    );

    titleRow.append(badge, titleEl, actions);
    header.appendChild(titleRow);
    header.appendChild(buildPreviewMeta(entry, detail));
    return header;
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
      // Older messages exist beyond the current window — offer to load them
      // (also auto-triggered when the user scrolls to the top, below).
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
    // reused for nested transcripts (subagent / teammate bodies) so capping +
    // pinned conclusions behave identically at every depth (D14).
    this.renderTimelineInto(body, detail.timeline ?? [], "root");

    // Scroll to the top → load older messages (incremental, while more remain).
    body.addEventListener("scroll", () => {
      if (body.scrollTop <= 48 && this.activePreviewDetail?.truncated && !this.previewLoadingMore) {
        this.requestMorePreview();
      }
    });

    this.setPreviewContent(this.buildPreviewHeader(entry, detail), body);
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
    this.postMessage({
      type: "requestVaultSessionDetail",
      entryId: this.activePreviewEntryId,
      limit: this.previewLimit,
    });
  }

  /** One timeline node: user/assistant message, thinking block, or tool/subagent step. */
  private renderTimelineItem(item: VaultTimelineItem): HTMLElement {
    if (item.kind === "message") {
      const label = item.role === "assistant" ? "Assistant" : "User";
      const suffix = item.timestamp ? ` · ${formatRelativeTime(item.timestamp)}` : "";
      return previewMessage(item.role, `${label}${suffix}`, item.text, true);
    }
    if (item.kind === "thinking") {
      return thinkingBlock(item.text);
    }
    if (item.kind === "subagentSession") {
      return this.renderSubagentSession(item);
    }
    if (item.kind === "teammateTurn") {
      return this.renderTeammateTurn(item);
    }
    if (item.kind === "teammateMessage") {
      return this.renderTeammateMessage(item);
    }
    return activityStep(item);
  }

  /**
   * A team-member communication turn (nest-workflow-team-sessions D13): a
   * color-highlighted, click-to-open node threaded into the leader's timeline.
   * The accent (left bar + dot) is driven by a sanitized `--turn-color`; the head
   * shows `@<member>` + a direction label (`⟵ leader` / `⟵ <peer>`); the preview
   * is the bounded incoming message. Clicking lazily fetches THIS turn's segment
   * by its view-only `:turn:` entryId, reusing the nested expand / stale-guard
   * machinery (populateNested + expandedNested).
   */
  private renderTeammateTurn(item: Extract<VaultTimelineItem, { kind: "teammateTurn" }>): HTMLElement {
    const entryId = item.entryId;
    const block = document.createElement("div");
    block.className = "vault-preview-teammate";
    block.style.setProperty("--turn-color", teammateAccent(item.color));

    const head = document.createElement("button");
    head.type = "button";
    head.className = "vault-preview-teammate-head";
    const dot = document.createElement("span");
    dot.className = "vault-preview-teammate-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "vault-preview-teammate-name";
    name.textContent = `@${item.agentName}`;
    const dir = document.createElement("span");
    dir.className = "vault-preview-teammate-dir";
    dir.textContent = item.from === "leader" ? "⟵ leader" : `⟵ ${item.from}`;
    const chevron = document.createElement("span");
    chevron.className = "vault-preview-teammate-chevron";
    chevron.innerHTML = ICON_CHEVRON_DOWN;
    chevron.setAttribute("aria-hidden", "true");
    head.append(dot, name, dir, chevron);
    const fromLabel = item.from === "leader" ? "leader" : item.from;
    head.title = `Open @${item.agentName}'s turn (from ${fromLabel})`;
    head.setAttribute("aria-label", `Teammate @${item.agentName} turn from ${fromLabel}`);

    const preview = document.createElement("p");
    preview.className = "vault-preview-teammate-preview";
    preview.textContent = item.preview;

    const body = document.createElement("div");
    body.className = "vault-preview-teammate-body";

    head.addEventListener("click", () => {
      if (this.expandedNested.has(entryId)) {
        this.expandedNested.delete(entryId);
        // Drop any in-flight nested request: collapsing mid-load must not let a
        // late response populate this now-hidden body (stale-guard, R4 WARN).
        this.pendingNested.delete(entryId);
        block.classList.remove("is-open");
        head.setAttribute("aria-expanded", "false");
        body.replaceChildren();
      } else {
        this.expandedNested.add(entryId);
        block.classList.add("is-open");
        head.setAttribute("aria-expanded", "true");
        this.populateNested(entryId, body);
      }
    });
    head.setAttribute("aria-expanded", this.expandedNested.has(entryId) ? "true" : "false");

    block.append(head, preview, body);
    if (this.expandedNested.has(entryId)) {
      block.classList.add("is-open");
      this.populateNested(entryId, body);
    }
    return block;
  }

  /**
   * An inline teammate communication (D16): an incoming `<teammate-message>`
   * record that lives in THIS transcript (a member's reply to the leader, or the
   * leader's request inside a member transcript). Unlike a `teammateTurn` node it
   * is NOT collapsible — the full body shows inline — but it carries the same
   * color-keyed accent + `@<sender>` / `⟵ leader` labeling so it never reads as a
   * generic "USER" turn. Built on `previewMessage` (no `overflow:hidden`, so no
   * flex-collapse) with the sanitized `--turn-color` applied.
   */
  private renderTeammateMessage(item: Extract<VaultTimelineItem, { kind: "teammateMessage" }>): HTMLElement {
    const suffix = item.timestamp ? ` · ${formatRelativeTime(item.timestamp)}` : "";
    const label = item.from === "leader" ? `⟵ leader${suffix}` : `@${item.agentName}${suffix}`;
    const el = previewMessage("teammate", label, item.text, true);
    el.style.setProperty("--turn-color", teammateAccent(item.color));
    return el;
  }

  /**
   * Collapsible nested sub-session (OpenCode subagent / workflow child). Shows
   * title + first message collapsed; expanding lazily fetches the child's
   * transcript and renders it nested (its own subagents become further blocks →
   * multi-tier). Expansion state survives root re-renders via `expandedNested`.
   */
  private renderSubagentSession(item: Extract<VaultTimelineItem, { kind: "subagentSession" }>): HTMLElement {
    const entryId = item.entryId;
    const block = document.createElement("div");
    block.className = "vault-preview-subagent";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "vault-preview-subagent-head";
    const chevron = document.createElement("span");
    chevron.className = "vault-preview-subagent-chevron";
    chevron.innerHTML = ICON_CHEVRON_DOWN;
    chevron.setAttribute("aria-hidden", "true");
    // Make a subagent spawn legible at a glance: an "agent" badge + the
    // accent-colored `@<agent>` chip mark it as a nested agent run and separate
    // the agent identity from the description (which the same value used to blur
    // into). Group nodes (workflow / team) carry no single agent — they keep the
    // title-only form. The description always lives in `-title` so the badge +
    // accent styling stays scoped to the agent.
    if (item.agent) {
      const badge = document.createElement("span");
      badge.className = "vault-preview-subagent-badge";
      badge.textContent = "agent";
      const agentEl = document.createElement("span");
      agentEl.className = "vault-preview-subagent-agent";
      agentEl.textContent = `@${item.agent}`;
      const sep = document.createElement("span");
      sep.className = "vault-preview-subagent-sep";
      sep.textContent = "·";
      sep.setAttribute("aria-hidden", "true");
      const titleEl = document.createElement("span");
      titleEl.className = "vault-preview-subagent-title";
      titleEl.textContent = item.title;
      head.append(chevron, badge, agentEl, sep, titleEl);
      // The split spans + `aria-hidden` separator would otherwise be announced as
      // "agent @reviewer · Review the diff"; a clean accessible name reads better.
      head.setAttribute("aria-label", `Subagent @${item.agent}: ${item.title}`);
    } else {
      const titleEl = document.createElement("span");
      titleEl.className = "vault-preview-subagent-title";
      titleEl.textContent = item.title;
      head.append(chevron, titleEl);
      // Group nodes (workflow / team) had no accessible name — give them one.
      head.setAttribute("aria-label", `Nested session: ${item.title}`);
    }
    // Hover hint for the expand/collapse toggle (both agent + group variants).
    head.title = item.agent ? `Toggle subagent @${item.agent}: ${item.title}` : `Toggle ${item.title}`;

    // First-message preview, shown while collapsed (hidden once expanded — the
    // child's own first message then leads the nested transcript).
    const firstMsg = document.createElement("p");
    firstMsg.className = "vault-preview-subagent-firstmsg";
    firstMsg.textContent = item.firstMessage ?? "";

    const body = document.createElement("div");
    body.className = "vault-preview-subagent-body";

    head.addEventListener("click", () => {
      if (this.expandedNested.has(entryId)) {
        this.expandedNested.delete(entryId);
        // Drop any in-flight nested request: collapsing mid-load must not let a
        // late response populate this now-hidden body (stale-guard, R4 WARN).
        this.pendingNested.delete(entryId);
        block.classList.remove("is-open");
        head.setAttribute("aria-expanded", "false");
        body.replaceChildren();
      } else {
        this.expandedNested.add(entryId);
        block.classList.add("is-open");
        head.setAttribute("aria-expanded", "true");
        this.populateNested(entryId, body);
      }
    });
    head.setAttribute("aria-expanded", this.expandedNested.has(entryId) ? "true" : "false");

    block.append(head, firstMsg, body);
    // Re-render (load-more / run expand) rebuilds the DOM — restore open state.
    if (this.expandedNested.has(entryId)) {
      block.classList.add("is-open");
      this.populateNested(entryId, body);
    }
    return block;
  }

  /** Fill a subagent block's body: from cache, or lazily fetch the child detail. */
  private populateNested(entryId: string, body: HTMLElement): void {
    const cached = this.nestedDetails.get(entryId);
    if (cached) {
      this.renderNestedInto(body, cached, entryId);
      return;
    }
    body.replaceChildren(loadingBody());
    const alreadyPending = this.pendingNested.has(entryId);
    this.pendingNested.set(entryId, body); // latest container wins (survives re-render)
    if (!alreadyPending) {
      this.postMessage({ type: "requestVaultSessionDetail", entryId });
    }
  }

  /** Render a child detail's timeline into a nested container. Reuses the shared
   *  run-grouping renderer (renderTimelineInto) so a nested transcript caps + pins
   *  conclusions exactly like the root preview; `entryId` keys its run expansions
   *  apart from the root's and from sibling nested blocks (D14). */
  private renderNestedInto(container: HTMLElement, detail: VaultSessionDetail, entryId: string): void {
    container.replaceChildren();
    const timeline = detail.timeline ?? [];
    if (timeline.length === 0) {
      const empty = document.createElement("p");
      empty.className = "vault-preview-subagent-empty";
      empty.textContent = "(no messages)";
      container.appendChild(empty);
      return;
    }
    this.renderTimelineInto(container, timeline, entryId);
  }

  /**
   * Render a timeline (root preview or a nested subagent/teammate body) into a
   * container: user messages flush-left; each run of AI output between them
   * (assistant text / thinking / tool calls) is indented and capped behind a
   * "Show N more" expand. Prominent nested nodes (subagent / workflow GROUP and
   * color-highlighted `teammateTurn`s) are first-class — they break the run and
   * ALWAYS render directly, never hidden behind the cap (nest-workflow-team-
   * sessions D10 + D13). Run-expansion keys are prefixed by `keyPrefix` so a
   * nested run's expand can't collide with a root run's (D14).
   */
  private renderTimelineInto(container: HTMLElement, timeline: VaultTimelineItem[], keyPrefix: string): void {
    let i = 0;
    let runIndex = 0;
    while (i < timeline.length) {
      const item = timeline[i];
      if (item.kind === "message" && item.role === "user") {
        container.appendChild(this.renderTimelineItem(item));
        i++;
        continue;
      }
      if (item.kind === "subagentSession" || item.kind === "teammateTurn" || item.kind === "teammateMessage") {
        container.appendChild(this.renderTimelineItem(item));
        i++;
        continue;
      }
      const run: VaultTimelineItem[] = [];
      while (i < timeline.length) {
        const it = timeline[i];
        if (it.kind === "message" && it.role === "user") {
          break;
        }
        if (it.kind === "subagentSession" || it.kind === "teammateTurn" || it.kind === "teammateMessage") {
          break;
        }
        run.push(it);
        i++;
      }
      this.renderRun(container, run, `${keyPrefix}#${runIndex++}`);
    }
  }

  /** Render one run of AI output, capped at 3 items with a "Show N more" expand
   *  (nest-workflow-team-sessions D10 — was 5; teammate/nested nodes break runs
   *  and are never part of one). When the run is capped, its concluding
   *  assistant message (last in the run) is pinned BELOW the expand so the
   *  highest-signal item stays visible instead of being buried at the tail:
   *  head (CAP-1 items) + "Show N more" + pinned conclusion. */
  private renderRun(body: HTMLElement, run: VaultTimelineItem[], key: string): void {
    const CAP = 3;
    const expanded = this.expandedRuns.has(key);
    if (expanded || run.length <= CAP) {
      for (const it of run) {
        body.appendChild(this.renderTimelineItem(it));
      }
      return;
    }

    // Capped run. The conclusion — a non-empty assistant message that is the
    // LAST item of the run — carries the most value but sits at the tail, where a
    // plain head slice would hide it behind the expand. Pin it: keep CAP-1 head
    // steps, then the expand, then the conclusion. Only pin when it is genuinely
    // the final item: pinning a mid-run assistant line (with tool/thinking steps
    // after it) would reorder the transcript and bury those trailing steps.
    const last = run[run.length - 1];
    const pin = last.kind === "message" && last.role === "assistant" && last.text.trim().length > 0;
    const headCount = pin ? CAP - 1 : CAP;
    for (let k = 0; k < headCount; k++) {
      body.appendChild(this.renderTimelineItem(run[k]));
    }

    // headCount + (pin ? the pinned tail : 0) are shown → the rest are hidden.
    const hidden = run.length - CAP;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "vault-preview-expand";
    btn.textContent = `Show ${hidden} more step${hidden === 1 ? "" : "s"}`;
    btn.title = "Show every step in this run";
    btn.addEventListener("click", () => {
      this.expandedRuns.add(key);
      if (this.activePreviewEntry && this.activePreviewDetail) {
        // renderPreviewDetail rebuilds the body from scratch, so the new body
        // starts at scrollTop 0 — preserve the current scroll so expanding a
        // run reveals its steps in place instead of jumping to the top. Content
        // above the button is positionally stable, so the same offset holds.
        const prevScroll = this.previewEl.querySelector<HTMLElement>(".vault-preview-body")?.scrollTop ?? 0;
        this.renderPreviewDetail(this.activePreviewEntry, this.activePreviewDetail);
        const newBody = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
        if (newBody) {
          newBody.scrollTop = prevScroll;
        }
      }
    });
    body.appendChild(btn);

    if (pin) {
      body.appendChild(this.renderTimelineItem(last));
    }
  }

  /** Scroll the preview body to the next (+1) / previous (-1) user message.
   *  Uses a margin equal to the post-scroll offset so the current message is
   *  excluded from the next search (otherwise "next" sticks on the first one). */
  private scrollToAdjacentUser(dir: 1 | -1): void {
    const body = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    if (!body) {
      return;
    }
    const users = Array.from(body.querySelectorAll<HTMLElement>(".vault-preview-message-user"));
    if (users.length === 0) {
      return;
    }
    const bodyTop = body.getBoundingClientRect().top;
    const positions = users.map((u) => u.getBoundingClientRect().top - bodyTop + body.scrollTop);
    const margin = 8;
    const cur = body.scrollTop;
    let target: number | undefined;
    if (dir === 1) {
      target = positions.find((p) => p > cur + margin);
    } else {
      const before = positions.filter((p) => p < cur - margin);
      target = before.length > 0 ? before[before.length - 1] : undefined;
    }
    if (target === undefined) {
      return; // already at the last (next) / first (prev) user message
    }
    body.scrollTo?.({ top: Math.max(0, target - margin), behavior: "smooth" });
  }

  /** Jump the preview to the latest message (bottom) — called on initial load. */
  private scrollPreviewToEnd(): void {
    const body = this.previewEl.querySelector<HTMLElement>(".vault-preview-body");
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }

  /**
   * Single-line CSS-grid row: badge | title | cwd-chip | time, with an
   * icon-only Resume revealed on hover/focus (no fork — D8). Session-derived
   * strings (title, cwd) are written via `textContent`; the only SVG inserted
   * is the agent's real brand icon from the closed icon map (D1).
   */
  private renderRow(entry: VaultSessionEntry, opts: { hideCwd?: boolean } = {}): HTMLElement {
    const row = document.createElement("div");
    row.className = "vault-row";
    row.setAttribute("role", "option");
    row.tabIndex = 0;
    row.dataset.entryId = entry.id;

    // Right-click opens the context menu (no separate "⋯" trigger).
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.openContextMenu(entry, ev, row);
    });

    // Click / Enter / Space activates the row → open the session preview.
    row.addEventListener("click", () => this.openPreview(entry, row));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        this.openPreview(entry, row);
      }
    });

    // Agent marker — a small accent-colored dot. The real brand icon lives on
    // the Agent group header + preview header, not on every row (keeps rows
    // compact and scannable).
    const dot = document.createElement("span");
    dot.className = "vault-row-dot";
    dot.title = agentLabel(entry.agent);
    dot.setAttribute("aria-label", agentLabel(entry.agent));
    // Known accents only — a session-derived agent string never becomes a class (W6).
    const accent = getAgentAccent(entry.agent);
    if (accent) {
      dot.classList.add(`vault-row-dot--${accent}`);
    }
    row.appendChild(dot);

    const titleEl = document.createElement("span");
    titleEl.className = "vault-row-title";
    titleEl.textContent = entry.title || "(untitled session)";
    titleEl.title = entry.title;
    row.appendChild(titleEl);

    if (!opts.hideCwd) {
      const cwdEl = document.createElement("span");
      cwdEl.className = "vault-row-cwd";
      cwdEl.title = entry.cwd;
      const folderIcon = document.createElement("span");
      folderIcon.className = "vault-row-cwd-icon";
      folderIcon.innerHTML = ICON_FOLDER;
      const leaf = document.createElement("span");
      leaf.className = "vault-cwd-leaf";
      leaf.textContent = leafSegment(entry.cwd);
      cwdEl.append(folderIcon, leaf);
      row.appendChild(cwdEl);
    } else {
      // Keep the grid column count stable when the cwd chip is suppressed.
      const spacer = document.createElement("span");
      spacer.className = "vault-row-cwd vault-row-cwd--empty";
      row.appendChild(spacer);
    }

    const timeEl = document.createElement("span");
    timeEl.className = "vault-row-time";
    timeEl.textContent = formatRelativeTime(entry.modified);
    row.appendChild(timeEl);

    const actions = document.createElement("span");
    actions.className = "vault-row-actions";
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "vault-action vault-action--resume";
    resumeBtn.title = "Resume";
    resumeBtn.setAttribute("aria-label", "Resume");
    resumeBtn.innerHTML = ICON_RESUME;
    resumeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation(); // don't also open the preview
      this.postMessage({ type: "vaultResume", entryId: entry.id });
    });
    actions.appendChild(resumeBtn);
    row.appendChild(actions);

    return row;
  }
}
