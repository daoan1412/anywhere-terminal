# Redesign brief — how to surface Claude Code agent teams & workflows in the AI Vault

> Paste the block below to a fresh Claude (or `/asimov-plan`). It is self-contained.

---

## Goal

Redesign **how Claude Code "agent teams" and "/workflow" runs are displayed** in the AI Vault
panel of the `anywhere-terminal` VS Code extension. The data layer already works — this is a
**presentation redesign**. The previous attempt embedded teammates/agents as nested collapsible
rows *inside the leader session's chronological transcript*; that was rejected as cluttered,
visually weak, and easy to miss. The chosen replacement (fully specified in
**"The chosen design"** below) keeps the in-timeline threading but makes each teammate/agent
interaction a **prominent, color-highlighted, click-to-open node**, and **segments a
conversational teammate into one node per communication turn**. Implement that design.

## Product context

The AI Vault lists past AI-coding sessions (Claude Code, OpenCode, Codex) as a flat, groupable
list of rows. Clicking a row opens a **detail preview overlay** that renders the session's
transcript as a chronological timeline (user/assistant messages, thinking blocks, tool steps,
and nested sub-sessions).

Claude Code can spawn child sessions in three ways — two are relevant here:

1. **Agent team.** A *leader* session spawns named *teammates* (the Agent tool with a `name`).
   Each teammate is its **own top-level session file** (`<uuid>.jsonl`) tagged with `teamName` +
   `agentName` in its records; its first user message is `<teammate-message …>`. The leader is a
   normal, long-lived session that opens with a real human prompt and records that same
   `teamName` on a minority of its records. A leader may run **multiple teams** over its life
   (each team is a transient episode). The leader's transcript also contains the raw
   `<teammate-message …>` coordination records inline. Example real case: leader
   "Create 4 teammates for ARCO v2 proposals" → teams `arco-v2-estimates` (4 members:
   `usdg-estimator`, `yield-protocol-estimator`, `aap-estimator`, `vault-router-estimator`) and
   `arco-v2-conduit` (1 member: `conduit-estimator`).

2. **Workflow (`/workflow`).** One run spawns N agents (e.g. 29) that run verify/audit/etc.
   Transcripts live at `<projectDir>/<parentId>/subagents/workflows/<wfId>/agent-*.jsonl`; a rich
   manifest at `<projectDir>/<parentId>/workflows/<wfId>.json` carries `workflowName`,
   `agentCount`, `status`, `phases[]`, and per-agent `workflowProgress[]` ({index,title,type}).

## What already exists (host-side, working — reuse it)

The Claude reader (`src/vault/readers/claudeReader.ts`, see
`asimov/changes/nest-workflow-team-sessions/design.md` D3/D4) already, reliably:

- **Detects team members** by the durable in-file `teamName`+`agentName` (the live team config
  `~/.claude/teams/<team>/config.json` is deleted on teardown — do NOT rely on it). It groups
  members by `teamName` and **excludes non-lead teammates from the top-level list** so they don't
  clutter it.
- **Discovers workflow runs** from the manifest, with per-agent labels.
- Resolves every teammate / workflow-agent transcript **lazily, by a validated id**, containment-
  checked under the Claude projects root.

Data available to the UI per leader:
- **Teams:** `[{ teamName, members: [{ sessionId, agentName, firstMessage, timestamp }] }]`.
  Each member is a **real, launchable/resumable session** (`claude:<uuid>`).
- **Workflows:** `[{ workflowName, agentCount, status, agents: [{ firstPrompt }] }]`. Workflow
  agents are **view-only** (synthetic ids, not resumable).
- **Leader:** a normal session entry (title, cwd, modified, transcript).

The verified-good entry id protocol is `<agent>:<sessionId>` (first-colon split). Synthetic
group/leaf ids carry markers (`:team:`, `:workflow:`, `:wfagent:`, `:subagent:`).

## Why the previous design failed (avoid these)

The teammates/workflow-agents were folded into the **leader's detail transcript** as nested
`subagentSession` collapsible boxes, placed chronologically among ~360 timeline items.

- **Buried.** They land deep in a long transcript, between thinking/tool steps, behind
  "Show N more steps" run-collapses. Easy to scroll past and never notice.
- **Mixed concerns.** A leader's *own* transcript and its *teammates* are different things; one
  chronological stream conflates them. The inline `<teammate-message>` records add more noise.
- **Visually weak.** The nested rows used theme CSS variables (`--vscode-panel-border`,
  `color-mix(... transparent)`) that render as near-invisible hairlines in real themes — the
  nodes were technically present but visually lost. Unit tests (jsdom, no layout/paint) did not
  catch this; only running the real Extension Dev Host did.
- **Verdict from the user:** fundamentally cluttered; "không nhúng teammate kiểu này" — don't
  embed teammates this way; want something prettier and simpler.

## The chosen design — a threaded, segmented teammate timeline (user-decided)

Interleaving with the leader's transcript is fine — the previous failure was that it was *weak
and buried*, not that it was interleaved. The new presentation keeps one chronological spine but
makes every teammate/agent interaction a **prominent, color-highlighted, click-to-open node**,
and **segments a conversational teammate into one node per communication turn** (a teammate is no
longer a single box — it recurs at each message it sends/receives).

Layout (mock with the real ARCO data):

```
Leader · "Create 4 teammates for ARCO v2 proposals"        bootstrap-agent · 1d
═══════════════════════════════════════════════════════════════════════════════
 [You · May 20]  Tạo 4 teammate xử lý 4 dự án: usdg, yield-protocol, aap…
     › Thinking · I need to set up four separate teammates…
     › Bash · ls …/templates              ⋯ Show N more        (cap = 3, then more)
 [Assistant]  4 teammate đã spawn song song trên team arco-v2-estimates.

 ┃🔵 usdg-estimator             ⟵ you spawned                        ▸ open
 ┃   "USDg sub-system. Skip Oracle, hours-based, output EN, no $…"
 ┃🟢 yield-protocol-estimator   ⟵ you spawned                        ▸ open
 ┃🟡 aap-estimator              ⟵ you spawned                        ▸ open
 ┃🟣 vault-router-estimator     ⟵ you spawned                        ▸ open

 ┃🔵 usdg-estimator  →  you                                          ▸ open
 ┃   "USDg proposal complete. Deliverables at bidding/arco-v2/usdg/…"
     › TaskUpdate 1
 [Assistant]  USDg ✅ — chờ 3 teammate còn lại.

 ┃🟢 yield-protocol-estimator  →  you      "Yield proposal complete (2/4)…"  ▸ open
 ┃🟣 vault-router-estimator  →  🔵 usdg-estimator  (peer)  "Mượn fee-split…"  ▸ open
```

Rules:
- **Highlight:** each teammate node gets a colored left bar + dot using the record's own `color`
  field (usdg=blue, yield=green, aap=yellow, vault-router=purple). Visually distinct from the
  leader's plain messages/steps — do NOT rely on subtle theme borders (that was the bug).
- **First message only, collapsed:** the node shows the request preview / `summary`; the
  teammate's internal steps are hidden. The leader's own tool/reasoning runs collapse at **cap 3**
  then "Show N more" (was 5).
- **Segmentation (decision #1, VERIFIED feasible):** a teammate appears once per communication
  turn. Each turn = one node. Opening a node opens **only that one segment** — from the incoming
  request to the response back to the requestor — NOT the whole teammate session.
- **Direction + peer (decision #2):** `⟵ you spawned` / `→ you` / `→ 🔵 peer-name (peer)`.
  Both leader↔teammate and teammate↔teammate (peer DM) are in scope for v1.
- **Spawn node (decision #3):** the `⟵ you spawned` node's preview is the teammate's first user
  message (the task the leader handed it).
- **One-shot agents:** subagents (Oracle/Verify) and workflow agents do NOT segment — one node
  each, showing the first prompt, click-to-open (they have no back-and-forth).
- Replace the raw inline `<teammate-message>` user records with these nodes — don't show both.

### Segmentation — verified against real data (decision #1)

Confirmed by inspecting a real teammate file (`23bb2eca…`, usdg-estimator, 113 records):
- A teammate transcript is a sequence of turns. **Each turn begins at a `user` record whose text
  is `<teammate-message teammate_id="X">`** (the incoming message). usdg has these at record 2
  (`X=team-lead`) and record 35 (`X=team-lead`); between them is the teammate's work
  (thinking → Read/Bash/Write → text). A **segment = [that incoming message] → [all work] → up to
  the next incoming `<teammate-message>` (or EOF)** — exactly "from processing the request to the
  response back to the requestor."
- **Sender/direction comes free:** `teammate_id="team-lead"` ⇒ from the leader;
  `teammate_id="<other-teammate-name>"` ⇒ a peer DM. So direction and peer-detection need no
  extra source.
- **Leader-side labels:** the leader file holds the delivered replies as
  `<teammate-message teammate_id="usdg-estimator" color="blue" summary="…">` — use `color` for the
  highlight and `summary` for the node's one-line preview.
- **Placement:** order all nodes (leader steps + teammate-turn nodes) by record `timestamp`.
- **Opening one segment:** resolve the teammate session by id, then render only the record range
  of that turn (incoming-message index → next-incoming index). This is a new "segment" detail mode
  (id like `claude:<teammateId>:turn:<n>` or by timestamp range), still resolved host-side by id +
  containment check — never a webview-supplied range.

### Directions explicitly REJECTED (for the record)

The earlier options of pulling teammates entirely OUT of the transcript (a list-group, a header
chip-strip, or a separate "related sessions" pane) are NOT what the user wants — the value is
seeing the teammate turns *threaded in place* in the leader's flow.

## Constraints

- **Stack:** 3-layer VS Code extension — extension host ↔ `postMessage` ↔ **vanilla-TS webview**
  (no React/framework). Reuse existing webview patterns: list rows, collapsible group headers,
  the detail overlay. Build: esbuild + pnpm; tests: Vitest (unit/jsdom).
- **Security (must hold):** all session-derived text via `textContent` only (never HTML);
  the host resolves sessions **by id**, containment-checked under the projects root — never trust
  a webview-supplied path; SVG/icons only from the closed icon map / static constants; clipboard
  host-side via `vscode.env.clipboard`.
- **Behavior to keep:** teammates stay excluded from the flat top-level list (no regression to
  the old `<teammate-message>`-titled clutter); each teammate remains independently
  openable/resumable; workflow agents are view-only.
- **Run cap (decision #4):** the leader's tool/reasoning run cap drops from 5 to **3** items
  before "Show N more" (`renderRun` CAP). Teammate-turn nodes are NOT part of a run — they always
  render (the D10 run-break already does this).
- **Verify in the real Extension Dev Host**, not only unit tests — the invisibility bug above
  proves jsdom tests miss CSS/layout/paint problems. After building, do a clean relaunch
  (Shift+F5 → F5), and note: the webview script URL is now cache-busted (`?v=<mtime>`), so a
  reload reliably picks up a rebuilt bundle.

## Reference

- Existing data layer + decisions: `asimov/changes/nest-workflow-team-sessions/`
  (`design.md` D3/D4 = team/workflow discovery; `specs/agent-session-index/spec.md`).
- Reader entry points: `readClaudeDetail`, `listClaudeTeamStubs`, `listClaudeWorkflowStubs`,
  `readClaudeTeamDetail` in `src/vault/readers/claudeReader.ts`.
- Current (rejected) render path: `renderSubagentSession` / `renderPreviewDetail` in
  `src/webview/vault/VaultPanel.ts`; nested-node CSS in `src/webview/vault/vaultPanel.css`
  (`.vault-preview-subagent*`).
