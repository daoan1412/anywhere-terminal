// src/webview/vault/VaultPanel.ts — Flat, searchable AI-vault session list.
// See: asimov/changes/add-ai-coding-vault/specs/vault-panel/spec.md,
//      design.md D10 (mirrors FileTreePanel's composition, NOT its Tree).
//
// Renders the aggregated session list as a plain list with a client-side search
// box (no per-keystroke host round-trip). Session titles are UNTRUSTED (derived
// from agent transcripts) — every dynamic string is written via textContent,
// never innerHTML, so a crafted title cannot inject markup.

import type { RequestVaultSessionsMessage, VaultForkMessage, VaultResumeMessage } from "../../types/messages";
import type { VaultListResult, VaultSessionEntry } from "../../vault/types";

export type VaultPanelPostMessage = (m: RequestVaultSessionsMessage | VaultResumeMessage | VaultForkMessage) => void;

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

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent;
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
  private readonly countEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly folderToggleEl: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly persistCollapsed?: (collapsed: boolean) => void;
  private readonly persistFolderOnly?: (folderOnly: boolean) => void;

  private entries: VaultSessionEntry[] = [];
  private unreadable = 0;
  private query = "";
  private collapsed = true;
  /** "This folder only" filter — scope the list to `contextCwd` when on. */
  private folderOnly = false;
  /** Active terminal pane's cwd; the folder filter scopes to this. */
  private contextCwd: string | null = null;

  constructor(deps: VaultPanelDeps) {
    this.host = deps.host;
    this.postMessage = deps.postMessage;
    this.persistCollapsed = deps.persistCollapsed;
    this.persistFolderOnly = deps.persistFolderOnly;

    this.host.classList.add("vault-panel");
    this.host.replaceChildren();

    // Header doubles as the collapse toggle (chevron + title + session count).
    const header = document.createElement("div");
    header.className = "vault-header";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-label", "Toggle AI Vault");
    header.setAttribute("aria-expanded", "false");

    const chevron = document.createElement("span");
    chevron.className = "vault-header__chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");

    const title = document.createElement("span");
    title.className = "vault-title";
    title.textContent = "AI Vault";

    this.countEl = document.createElement("span");
    this.countEl.className = "vault-header__count";

    header.append(chevron, title, this.countEl);

    const toggle = () => this.toggleCollapsed();
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    });
    this.headerEl = header;

    const searchWrap = document.createElement("div");
    searchWrap.className = "vault-search";
    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.className = "vault-search-input";
    this.searchInput.placeholder = "Search sessions…";
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.renderList();
    });
    searchWrap.appendChild(this.searchInput);

    // "This folder only" — scope the list to the active terminal pane's cwd.
    this.folderToggleEl = document.createElement("button");
    this.folderToggleEl.type = "button";
    this.folderToggleEl.className = "vault-folder-toggle";
    this.folderToggleEl.textContent = "This folder only";
    this.folderToggleEl.setAttribute("aria-pressed", "false");
    this.folderToggleEl.addEventListener("click", () => this.toggleFolderOnly());
    searchWrap.appendChild(this.folderToggleEl);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "vault-status";

    this.listEl = document.createElement("div");
    this.listEl.className = "vault-list";

    this.host.append(header, searchWrap, this.statusEl, this.listEl);

    // Seed collapsed state (default collapsed) — reconciles the HTML's
    // `vault-collapsed` default with any persisted preference.
    this.setCollapsed(deps.getInitialCollapsed?.() ?? true, { persist: false });
    this.setFolderOnly(deps.getInitialFolderOnly?.() ?? false, { persist: false });
  }

  /** Whether the vault section is collapsed to its header strip. */
  isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Collapse/expand the section. Persists unless `persist: false`. */
  setCollapsed(collapsed: boolean, opts: { persist?: boolean } = {}): void {
    const wasCollapsed = this.collapsed;
    this.collapsed = collapsed;
    this.host.classList.toggle("vault-collapsed", collapsed);
    this.headerEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (opts.persist !== false) {
      this.persistCollapsed?.(collapsed);
    }
    // Becoming visible → re-read the session list (the agents' on-disk files
    // are the source of truth, D2; matches the "refresh on open" spec). Only
    // on the collapsed→expanded transition so re-collapsing doesn't fetch and
    // an already-open panel isn't re-fetched on a no-op.
    if (!collapsed && wasCollapsed) {
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
    this.folderToggleEl.classList.toggle("is-active", folderOnly);
    this.folderToggleEl.setAttribute("aria-pressed", folderOnly ? "true" : "false");
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

  /** Render the aggregated result; preserves the current search query. */
  render(result: VaultListResult): void {
    this.entries = result.entries;
    this.unreadable = result.unreadable;
    this.renderList();
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
    if (this.unreadable > 0) {
      const notice = document.createElement("div");
      notice.className = "vault-notice";
      notice.textContent = `${this.unreadable} session${this.unreadable === 1 ? "" : "s"} could not be read.`;
      this.statusEl.appendChild(notice);
    }
    if (this.entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vault-empty";
      empty.textContent = "No AI sessions found.";
      this.statusEl.appendChild(empty);
    } else if (visibleCount === 0) {
      const empty = document.createElement("div");
      empty.className = "vault-empty";
      // Distinguish "filtered out by folder scope" from "no search match" so
      // the empty state is actionable (turn off the folder filter vs. clear search).
      empty.textContent =
        this.folderOnly && this.contextCwd && !this.query
          ? "No sessions in this folder."
          : "No sessions match your search.";
      this.statusEl.appendChild(empty);
    }
  }

  private renderList(): void {
    const visible = this.entries.filter((e) => this.matchesFolder(e) && this.matchesQuery(e));
    // The badge reflects what the list actually shows (folder + search scoped),
    // not the unfiltered total — otherwise it over-reports under an active
    // filter. See .reviews/round-2.md [W2].
    this.countEl.textContent = visible.length > 0 ? String(visible.length) : "";
    this.renderStatus(visible.length);

    this.listEl.replaceChildren();
    for (const entry of visible) {
      this.listEl.appendChild(this.renderRow(entry));
    }
  }

  private renderRow(entry: VaultSessionEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "vault-row";

    const badge = document.createElement("span");
    badge.classList.add("vault-badge");
    // Per-agent modifier class — guard the suffix so an unexpected agent id
    // can't split into extra class tokens (classList.add rejects whitespace).
    if (/^[a-z0-9-]+$/i.test(entry.agent)) {
      badge.classList.add(`vault-badge--${entry.agent}`);
    }
    badge.textContent = agentLabel(entry.agent);
    row.appendChild(badge);

    const main = document.createElement("div");
    main.className = "vault-row-main";

    const titleEl = document.createElement("div");
    titleEl.className = "vault-row-title";
    titleEl.textContent = entry.title || "(untitled session)";
    titleEl.title = entry.title;
    main.appendChild(titleEl);

    const meta = document.createElement("div");
    meta.className = "vault-row-meta";
    const cwdEl = document.createElement("span");
    cwdEl.className = "vault-row-cwd";
    cwdEl.textContent = entry.cwd;
    cwdEl.title = entry.cwd;
    const timeEl = document.createElement("span");
    timeEl.className = "vault-row-time";
    timeEl.textContent = formatRelativeTime(entry.modified);
    meta.append(cwdEl, timeEl);
    main.appendChild(meta);

    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "vault-row-actions";

    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "vault-action vault-action--resume";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => this.postMessage({ type: "vaultResume", entryId: entry.id }));
    actions.appendChild(resumeBtn);

    if (entry.canFork) {
      const forkBtn = document.createElement("button");
      forkBtn.type = "button";
      forkBtn.className = "vault-action vault-action--fork";
      forkBtn.textContent = "Fork";
      forkBtn.addEventListener("click", () => this.postMessage({ type: "vaultFork", entryId: entry.id }));
      actions.appendChild(forkBtn);
    }

    row.appendChild(actions);
    return row;
  }
}
