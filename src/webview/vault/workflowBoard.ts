// src/webview/vault/workflowBoard.ts — Single-layer master-detail board for a
// Claude `/workflow` run (render-vault-workflow-board D3/D4/D6/D7). Left = a
// collapsible Phases tree (each phase expands to its agent leaves); right = the
// selected agent's transcript. Agents live in ONE place (the tree) — picking a
// leaf fills the right pane, so there are no intermediate cards and no back button.
// The transcript is NOT re-implemented here: it reuses the shared nested-detail
// path via `bag.populateNested` (D3). Selection (open phases + open agent) is
// local DOM, but persisted through the bag so a preview re-render (e.g. "Show N
// more steps" inside the open transcript) restores it instead of resetting (D4).
// All session-derived text goes through textContent.

import type { VaultTimelineItem } from "../../vault/types";
import { formatTokens } from "./format";
import type { PreviewTimelineBag } from "./previewTimeline";

type WorkflowBoardItem = Extract<VaultTimelineItem, { kind: "workflowBoard" }>;
type BoardAgent = WorkflowBoardItem["agents"][number];

/** Min width (px) each pane keeps while the splitter drags (D7). */
const MIN_PANE = 160;

/** Strip the `claude-` vendor prefix; keep the rest (incl. a `[1m]` context tag). */
function fmtModel(raw: string): string {
  return raw.replace(/^claude-/, "");
}

/** Compact run duration: 850 → "850ms", 5000 → "5s", 334884 → "5m 35s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** One agent's meta line: "model · 5.0k tok · 3 tools · 2s" (only present parts). */
function agentMeta(agent: BoardAgent): string {
  const parts: string[] = [];
  if (agent.model) {
    parts.push(fmtModel(agent.model));
  }
  if (agent.tokens !== undefined) {
    parts.push(`${formatTokens(agent.tokens)} tok`);
  }
  if (agent.toolCalls !== undefined) {
    parts.push(`${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`);
  }
  if (agent.durationMs !== undefined) {
    parts.push(fmtDuration(agent.durationMs));
  }
  return parts.join(" · ");
}

/** Run-level meta line under the header. */
function boardMeta(item: WorkflowBoardItem): string {
  const parts: string[] = [];
  const agentCount = item.agentCount ?? item.agents.length;
  parts.push(`${agentCount} agent${agentCount === 1 ? "" : "s"}`);
  if (item.durationMs !== undefined) {
    parts.push(fmtDuration(item.durationMs));
  }
  if (item.totalTokens !== undefined) {
    parts.push(`${formatTokens(item.totalTokens)} tok`);
  }
  if (item.totalToolCalls !== undefined) {
    parts.push(`${item.totalToolCalls} tool call${item.totalToolCalls === 1 ? "" : "s"}`);
  }
  if (item.model) {
    parts.push(fmtModel(item.model));
  }
  return parts.join(" · ");
}

/** Ordered phase groups; agents whose `phaseIndex` matches no phase fall into a
 *  trailing "Other" group so none are silently hidden. */
function groupAgents(
  item: WorkflowBoardItem,
): { title: string; phaseKey: number; detail?: string; agents: { agent: BoardAgent; ai: number }[] }[] {
  // Single pass: bucket agents by phaseIndex; unmatched ones fall to "Other".
  const known = new Set(item.phases.map((p) => p.index));
  const byPhase = new Map<number, { agent: BoardAgent; ai: number }[]>();
  const orphans: { agent: BoardAgent; ai: number }[] = [];
  item.agents.forEach((agent, ai) => {
    if (known.has(agent.phaseIndex)) {
      const list = byPhase.get(agent.phaseIndex) ?? [];
      list.push({ agent, ai });
      byPhase.set(agent.phaseIndex, list);
    } else {
      orphans.push({ agent, ai });
    }
  });
  const groups = item.phases.map((p) => ({
    title: p.title,
    phaseKey: p.index,
    detail: p.detail,
    agents: byPhase.get(p.index) ?? [],
  }));
  if (orphans.length > 0) {
    groups.push({ title: "Other", phaseKey: Number.NaN, detail: undefined, agents: orphans });
  }
  return groups;
}

/** Drag the splitter to resize the left pane within min bounds (D7). The `document`
 *  move/up listeners exist only for the duration of one drag: a re-entrant mousedown
 *  is ignored (no stacking), and a drag is force-released if the board is detached
 *  mid-drag (e.g. the overlay closes) so no handler outlives its DOM. */
function attachSplitter(handle: HTMLElement, panes: HTMLElement, left: HTMLElement, board: HTMLElement): void {
  let dragging = false;
  function onMove(e: MouseEvent): void {
    if (!dragging) {
      return;
    }
    if (!board.isConnected) {
      stop(); // board torn down mid-drag → release immediately
      return;
    }
    const rect = panes.getBoundingClientRect();
    const upper = rect.width - MIN_PANE;
    const raw = e.clientX - rect.left;
    const basis = Math.max(MIN_PANE, Math.min(raw, upper > MIN_PANE ? upper : MIN_PANE));
    left.style.flexBasis = `${basis}px`;
  }
  function stop(): void {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", stop);
  }
  handle.addEventListener("mousedown", (e) => {
    if (dragging) {
      return; // a drag is already active — don't stack a second listener pair
    }
    e.preventDefault();
    dragging = true;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stop);
  });
}

/**
 * Render a `workflowBoard` timeline item. Self-contained: owns its panes, Phases
 * tree, splitter, and selection; the per-agent transcript is delegated to
 * `bag.populateNested`. Selection persists through the bag (keyed by `wfId`) so a
 * re-render restores the open phases + open agent.
 */
export function renderWorkflowBoard(item: WorkflowBoardItem, bag: PreviewTimelineBag): HTMLElement {
  const board = document.createElement("div");
  board.className = "vault-wfboard";

  const groups = groupAgents(item);
  const boardKey = item.wfId;
  const saved = bag.getBoardSelection(boardKey);
  const openPhases = new Set<number>(saved?.open ?? []); // Set handles the NaN "Other" key
  let selectedEntryId: string | null = saved?.agentEntryId ?? null;
  // The board folds ITSELF — one layer, no wrapper node (the header is the toggle).
  // Start collapsed unless previously expanded or an agent is open (must stay visible).
  let expanded = (saved?.expanded ?? false) || selectedEntryId !== null;

  // phaseKey → its DOM nodes, so restoring a selection can re-open the right phase.
  const phaseEls = new Map<number, HTMLElement>();

  const persist = (): void => {
    bag.setBoardSelection(boardKey, { expanded, open: [...openPhases], agentEntryId: selectedEntryId });
  };

  // Header IS the collapse toggle (button → spans only): a row (caret · "Workflow:
  // <name>" · status) plus a one-line summary peek shown ONLY while collapsed, so the
  // session view has a bit of description beyond the name.
  const header = document.createElement("button");
  header.type = "button";
  header.className = "vault-wfboard-header";
  const headRow = document.createElement("span");
  headRow.className = "vault-wfboard-head-row";
  const caret = document.createElement("span");
  caret.className = "vault-wfboard-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▸"; // direction shown via CSS rotate on the expanded board
  const name = document.createElement("span");
  name.className = "vault-wfboard-name";
  name.textContent = `Workflow: ${item.workflowName}`;
  headRow.append(caret, name);
  if (item.status) {
    const chip = document.createElement("span");
    chip.className = "vault-wfboard-status";
    chip.textContent = item.status;
    headRow.appendChild(chip);
  }
  header.appendChild(headRow);
  if (item.summary) {
    const subtitle = document.createElement("span");
    subtitle.className = "vault-wfboard-subtitle";
    subtitle.textContent = item.summary;
    header.appendChild(subtitle);
  }
  board.appendChild(header);

  // Foldable body: a framed description box (summary · run meta) · the two panes.
  const body = document.createElement("div");
  body.className = "vault-wfboard-body";
  board.appendChild(body);
  const desc = document.createElement("div");
  desc.className = "vault-wfboard-desc";
  if (item.summary) {
    const summary = document.createElement("p");
    summary.className = "vault-wfboard-summary";
    summary.textContent = item.summary;
    desc.appendChild(summary);
  }
  const meta = document.createElement("div");
  meta.className = "vault-wfboard-meta";
  meta.textContent = boardMeta(item);
  desc.appendChild(meta);
  body.appendChild(desc);

  const panes = document.createElement("div");
  panes.className = "vault-wfboard-panes";
  const left = document.createElement("div");
  left.className = "vault-wfboard-left";
  const split = document.createElement("div");
  split.className = "vault-wfboard-split";
  split.setAttribute("aria-hidden", "true");
  const right = document.createElement("div");
  right.className = "vault-wfboard-right";
  panes.append(left, split, right);
  body.appendChild(panes);

  const leftTitle = document.createElement("div");
  leftTitle.className = "vault-wfboard-pane-title";
  leftTitle.textContent = "Phases";
  left.appendChild(leftTitle);

  const rightBody = document.createElement("div");
  rightBody.className = "vault-wfboard-right-body";
  right.appendChild(rightBody);

  const applyExpanded = (): void => {
    board.classList.toggle("is-collapsed", !expanded);
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
  };
  applyExpanded();
  header.addEventListener("click", () => {
    expanded = !expanded;
    applyExpanded();
    persist();
  });

  const clearSelection = (selector: string): void => {
    for (const el of board.querySelectorAll(`${selector}.sel`)) {
      el.classList.remove("sel");
    }
  };

  const ensurePhaseOpen = (phaseKey: number): void => {
    openPhases.add(phaseKey);
    const phase = phaseEls.get(phaseKey);
    phase?.classList.add("is-open");
    phase?.querySelector(".vault-wfboard-phase-head")?.setAttribute("aria-expanded", "true");
  };

  const showHint = (): void => {
    rightBody.replaceChildren();
    const hint = document.createElement("p");
    hint.className = "vault-wfboard-empty";
    hint.textContent = "Select an agent to view its transcript.";
    rightBody.appendChild(hint);
  };

  const showAgentDetail = (agent: BoardAgent, ai: number, phaseKey: number): void => {
    if (!agent.entryId) {
      return; // non-clickable: no transcript file (D2/spec no-op)
    }
    selectedEntryId = agent.entryId;
    if (!expanded) {
      expanded = true; // an open agent's transcript must be visible
      applyExpanded();
    }
    ensurePhaseOpen(phaseKey); // keep the selected leaf visible in the tree
    clearSelection(".vault-wfboard-leaf");
    board.querySelector(`.vault-wfboard-leaf[data-ai="${ai}"]`)?.classList.add("sel");

    rightBody.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "vault-wfboard-detail-head";
    heading.textContent = agent.label;
    rightBody.appendChild(heading);
    const m = agentMeta(agent);
    if (m) {
      const metaEl = document.createElement("div");
      metaEl.className = "vault-wfboard-detail-meta";
      metaEl.textContent = m;
      rightBody.appendChild(metaEl);
    }
    const detail = document.createElement("div");
    // Own class only — NOT `.vault-preview-subagent-body`, whose `display` depends on
    // a `.vault-preview-subagent.is-open` ancestor the board doesn't provide (that
    // coupling silently hid the transcript when the board wasn't nested in a group).
    detail.className = "vault-wfboard-detail-body";
    rightBody.appendChild(detail);
    persist();
    bag.populateNested(agent.entryId, detail);
  };

  function agentLeaf(agent: BoardAgent, ai: number, phaseKey: number): HTMLElement {
    const interactive = !!agent.entryId;
    const leaf = document.createElement(interactive ? "button" : "div");
    leaf.className = "vault-wfboard-leaf";
    leaf.dataset.ai = String(ai);
    leaf.textContent = agent.label;
    if (interactive) {
      (leaf as HTMLButtonElement).type = "button";
      leaf.title = agent.label;
      leaf.addEventListener("click", () => showAgentDetail(agent, ai, phaseKey));
    } else {
      leaf.classList.add("is-disabled");
      leaf.title = `${agent.label} — no transcript recorded`;
    }
    return leaf;
  }

  // Build the Phases tree. Phase heads only toggle their own subtree — selection of
  // an agent (the right pane) is independent, so collapsing never disturbs it.
  for (const group of groups) {
    const phase = document.createElement("div");
    phase.className = "vault-wfboard-phase";
    if (openPhases.has(group.phaseKey)) {
      phase.classList.add("is-open");
    }

    const head = document.createElement("button");
    head.type = "button";
    head.className = "vault-wfboard-phase-head";
    head.dataset.pi = String(group.phaseKey);
    head.setAttribute("aria-expanded", openPhases.has(group.phaseKey) ? "true" : "false");
    head.title = group.detail ? `${group.title} — ${group.detail}` : group.title;
    const caret = document.createElement("span");
    caret.className = "vault-wfboard-phase-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▸";
    const phaseTitle = document.createElement("span");
    phaseTitle.className = "vault-wfboard-phase-title";
    phaseTitle.textContent = group.title;
    const count = document.createElement("span");
    count.className = "vault-wfboard-phase-count";
    count.textContent = `${group.agents.length}`;
    head.append(caret, phaseTitle, count);

    const leaves = document.createElement("div");
    leaves.className = "vault-wfboard-phase-agents";
    for (const { agent, ai } of group.agents) {
      leaves.appendChild(agentLeaf(agent, ai, group.phaseKey));
    }

    head.addEventListener("click", () => {
      const open = phase.classList.toggle("is-open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        openPhases.add(group.phaseKey);
      } else {
        openPhases.delete(group.phaseKey);
      }
      persist();
    });

    phase.append(head, leaves);
    left.appendChild(phase);
    phaseEls.set(group.phaseKey, phase);
  }

  // Restore the open agent (so a re-render keeps it + its now-expanded run), else hint.
  let restored = false;
  if (selectedEntryId) {
    for (const group of groups) {
      const match = group.agents.find(({ agent }) => agent.entryId && agent.entryId === selectedEntryId);
      if (match) {
        showAgentDetail(match.agent, match.ai, group.phaseKey);
        restored = true;
        break;
      }
    }
  }
  if (!restored) {
    selectedEntryId = null;
    showHint();
  }

  attachSplitter(split, panes, left, board);
  return board;
}
