# Proposal: support-nested-subagent-preview

## Why

Claude Code (v2.1.172+) now lets a subagent spawn its own subagents (depth ≤ 5). The vault
preview currently **flattens** these nested subagents into the root session (matched by
description, then dumped as root-level siblings) and cannot drill past depth 1 — so the
subagent tree is lost and counts desync. The on-disk tree is exactly reconstructable from
each subagent's `meta.toolUseId`.

## Appetite

M (≤3d)

## Scope

### In scope
- Claude reader: reconstruct the true subagent tree using `meta.toolUseId`; each transcript
  (root or subagent) embeds **only its direct children**; expanding a subagent discovers and
  embeds **its** children → recursion through the already-recursive renderer.
- Backward compatibility: legacy transcripts without `toolUseId` keep the current
  description-match + timestamp-merge behavior (no regression on existing sessions).
- Terminal subagent popup: replace the flat `FLAT_BAG` no-op `populateNested` with real
  lazy nested drill-down (mirroring the panel), reusing the existing cycle/disposal guards.
- Per-level `subagentCount` (direct children of the rendered transcript).

### Out of scope
- Renderer / data-model changes — `PreviewController` + `previewTimeline` + `VaultTimelineItem`
  already render arbitrary depth with cycle detection (verified, no change needed).
- OpenCode / Codex nesting — already direct-child-correct (parent_id / thread_spawn_edges);
  untouched.
- Any new `VaultTimelineItem` field or brand-new IPC message type (`toolUseId` is an internal
  stub field; the popup's nested fetch **extends the existing `requestSubagentPreview`
  round-trip** with an optional `entryId` rather than adding a message or borrowing the panel's
  `requestVaultSessionDetail` channel).
- A dedicated nesting-depth UI cap or "tree vs flat" toggle.

## Capabilities

1. **vault-session-preview** (MODIFIED) — Claude nested sub-sessions are placed by
   `meta.toolUseId` (the spawning `tool_use` id), scoped to each transcript's direct children,
   recursively expandable; description matching becomes the legacy fallback.
2. **terminal-subagent-preview** (MODIFIED) — the terminal click popup supports nested
   drill-down instead of rendering flat.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — the preview panel and the terminal popup will
  show nested subagents as a proper expandable tree instead of a flat list.
- **E2E required?** NOT REQUIRED — repo has no E2E harness (`project.md` § Commands: E2E N/A).
- **Justification**: Behavior is covered by reader **unit tests** (Vitest) against a real
  depth-2 fixture, plus a manual check in the running extension. The render layer is unchanged
  and already tested.

## Risk Level

MEDIUM — touches the shared Claude classify/matching path used by every Claude preview;
the regression surface is legacy/mixed sessions, contained by the description fallback and
unit tests.
