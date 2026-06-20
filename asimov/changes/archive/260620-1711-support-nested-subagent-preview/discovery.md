# Discovery: support-nested-subagent-preview

## Trigger

Claude Code now supports **nested subagents** — a subagent can itself spawn subagents
(main → subagent → sub‑subagent). Question: does the vault **session preview** need
updating to render them? (User emphasis: "especially session preview".)

## Workstreams

| Workstream | Method | Outcome |
|---|---|---|
| External feature facts | librarian (docs/changelog) | Confirmed: nested subagents land in Claude Code **v2.1.172**; **depth cap 5** (a subagent at depth 5 gets no Agent tool), fixed/not configurable. Stored as `isSidechain`+`parentUuid` sidechains (same mechanism at every depth). Official UI renders a **tree**. Note saved → `docs/research/20260620-claude-code-nested-subagents.md`. |
| On‑disk layout | Direct FS inspection of `~/.claude/projects/**/subagents/` | Subagents stored **flat**: `<rootId>/subagents/<stem>.jsonl` + `<stem>.meta.json = {agentType, description, toolUseId}`. **No** per‑parent nested `subagents/` subdirs anywhere. Only sibling dir is `workflows/`. |
| Internal data/render depth | finder + direct code read | Renderer + data model are **already recursive** (cycle‑detected). Reader **flattens** nested children to root. Terminal popup is **flat by spec**. |
| Linkage key | meta inspection | Each subagent `.meta.json` carries `toolUseId` = the `tool_use` id of the `Task`/`Agent` call that spawned it. This is the parent→child edge. |

## Key findings

### F1 — Renderer + data model already handle arbitrary depth
- `VaultTimelineItem.subagentSession` carries a lazy `entryId`; `VaultSessionDetail.timeline`
  is recursive by composition (`src/vault/types.ts:164‑303`).
- `PreviewController` lazy‑fetches nested details, caches them, and has an explicit
  **cycle detector** `renderingNested` (`src/webview/vault/PreviewController.ts:75‑82,399‑426`);
  `renderNestedInto`/`renderTimelineItem` render a nested detail through the same path
  (`src/webview/vault/previewTimeline.ts:62‑144`). **No depth cap; no render change needed.**

### F2 — The Claude reader FLATTENS nested subagents to the root (the real gap)
- `listClaudeSubagentStubs(rootId)` lists **every** `*.jsonl` under `<rootId>/subagents/`
  flat — i.e. the whole subtree, not just direct children (`claudeChildren.ts:444‑490`).
- `classifyClaudeStyleEvents` matches a stub to a `Task`/`Agent` call **by description**
  during the root‑transcript walk (`detail.ts:586`); whatever is unmatched is dumped into
  the root timeline by timestamp via `mergeUnmatchedStubs` (`detail.ts:650`).
- Consequence with nested data: a sub‑subagent's spawning `Task` call lives inside *another
  subagent's* transcript, **not** the root's → it never matches during the root walk →
  it is **flattened as a root‑level sibling**. The true tree (A spawned B spawned C) is lost,
  and `subagentCount = max(spawnCalls, totalStubs)` (`detail.ts:655`) inflates/desyncs.

### F3 — Drill‑down stops at depth 1
- `readClaudeSubagentDetail` reads one subagent transcript flat with `includeSidechain:true`
  and passes **no `childStubs`** (`claudeChildren.ts:33‑50`). So expanding a subagent renders
  its own `Task` calls as plain, **non‑expandable** `subagent` steps — you cannot open a
  sub‑subagent from inside a subagent.

### F4 — Terminal subagent popup is flat by design (separate surface)
- `SubagentPreviewPopup` injects a `FLAT_BAG` whose `populateNested` is a no‑op
  (`src/webview/links/SubagentPreviewPopup.ts:29‑120`); spec `terminal-subagent-preview`
  L12 explicitly scopes nested expansion **out**. This is the live‑terminal click popup,
  distinct from the vault panel "session preview".

### F5 — Reconstruction key exists
- `meta.toolUseId` lets us partition subagents by **which transcript spawned them**:
  a stub is a *direct* child of the transcript whose `tool_use` blocks contain that id.
  This is more reliable than the current description match and is what enables a true tree
  without changing the on‑disk layout.

## Gap analysis

| Surface | Today (with nested data) | Desired |
|---|---|---|
| Vault panel preview — root | Nested subagents flatten to root siblings; count desyncs | Root shows only **direct** children; nested ones live under their real parent |
| Vault panel preview — drill‑down | Expanding a subagent shows flat `subagent` steps, no nesting | Expanding reveals that subagent's own children, recursively (renderer already supports) |
| Terminal popup | Flat (by spec) | Optional: enable drill‑down (replace `FLAT_BAG`) — or keep deferred |

## Critical caveat (open question)

**No real depth‑≥2 Task‑nested session exists on this machine.** Every `subagents/*.jsonl`
inspected is depth‑1; none contains a `Task`/`Agent` `tool_use`. The "11‑level" chain a
sub‑agent reported was the **SendMessage/team** mechanism (a parentUuid *message* chain in
one file), not Task nesting. Therefore the on‑disk layout for nested **Task** subagents is
**inferred** (most likely: same flat `<rootId>/subagents/` dir, child linked by
`meta.toolUseId` pointing at a `tool_use` inside the parent subagent's transcript), but
**unconfirmed**. A competing possibility: the child's records are appended as extra
`isSidechain` lines **inside the parent subagent's own file** (like the team mechanism), in
which case `readClaudeSubagentDetail` already renders them — interleaved, boundary lost.
→ The plan must either (a) validate against a freshly generated depth‑2 session before/early
in build, or (b) be defensive and degrade gracefully for both layouts + all current data.

## Options (approach for the vault preview)

| Option | What | Pros | Cons |
|---|---|---|---|
| **1. Lazy recursive drill‑down (toolUseId tree)** _(rec.)_ | Thread `toolUseId` into stubs; each transcript (root or subagent) attaches only stubs whose `toolUseId` ∈ its own `tool_use` ids; expanding a subagent re‑reads + computes its direct children → recursion via existing renderer | Proper tree; matches Claude Code's own UI; renderer/data model already support it; bounded by depth‑5 runtime + cycle detector; per‑level lazy I/O | New matching path + backward‑compat care so depth‑1/old/team data don't regress |
| 2. Eager full‑tree at root read | Build the whole parent→child tree upfront and nest stubs structurally | One pass; tree visible without expanding | More upfront I/O; bigger IPC payload; duplicates the lazy machinery the renderer already has |
| 3. Stop flatten + relabel only | Keep flat but fix count + mark nested as "(nested)" | Cheap | Doesn't actually render nesting — fails the ask |

## Risks

- **R1 (layout)** Inferred on‑disk layout for nested Task subagents (see caveat). Mitigation: graceful fallback for both representations + validate on a real depth‑2 session.
- **R2 (regression)** Switching root from "dump all unmatched" to "direct‑children‑only" could drop a depth‑1 subagent whose `Task` description didn't match / whose meta lacks `toolUseId` (older data). Mitigation: keep description fallback; a stub matching no transcript anywhere still surfaces at root.
- **R3 (cycle/cost)** Recursive reads on a large tree. Mitigation: depth‑5 runtime cap + existing `renderingNested` cycle detector + per‑level `limit`.

## Open questions for Gate 1

1. Scope: vault panel preview only, or also enable drill‑down in the **terminal popup**?
2. Validation: generate a real depth‑2 session to confirm layout **before** building, or build defensively and validate during build?
