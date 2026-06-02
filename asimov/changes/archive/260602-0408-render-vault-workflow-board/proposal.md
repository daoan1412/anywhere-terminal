# Proposal: render-vault-workflow-board

## Why
In the vault session preview a Claude `/workflow` run renders twice and badly — once as a 600-char blob of its own 13 KB script (the `Workflow` tool_use), once as a generic group node whose agents are a flat list of near-identical first-prompts — while the run manifest already holds everything needed to reproduce the CLI's phase/agent board. This change surfaces that board and reuses the existing transcript preview for per-agent drill-down.

## Appetite
M (≤3d)

## Scope

### In scope
- Reader: build workflow detail from the manifest's `workflowProgress` (phases + per-agent stats + `:wfagent:` drill-down id); fall back to the current first-prompt list when absent.
- New `workflowBoard` timeline item kind.
- Webview: a two-pane master-detail board (Phases tree | Agents/detail) with a draggable splitter; per-agent transcript reuses the shared nested session-detail path.
- Suppress the raw `Workflow` tool_use activity blob.
- Delete the throwaway `.wf-mockup*` prototype files.

### Out of scope
- Live/streaming workflow state (sessions are read post-hoc; no per-agent done/running state).
- Changing the workflow manifest format or the CLI board.
- Team-turn / subagent (non-workflow) rendering.
- Persisting board splitter geometry (whole-panel resize stays FloatingWindow's job).

## Capabilities

1. **vault-workflow-board** (new) — render a workflow run in the session preview as a manifest-fed two-pane board whose agent detail reuses the session-detail transcript renderer, and suppress the raw `Workflow` tool call.
2. **agent-session-index** (modified) — the "Surface workflow sub-agents" requirement now renders the expanded group as a manifest-backed `workflowBoard` (was: a first-prompt agent list), with first-prompt as the fallback when `workflowProgress` is unusable.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — new board UI inside the workflow node in the preview overlay.
- **E2E required?** NOT REQUIRED — no E2E harness in this repo (project.md: E2E N/A); the change is webview rendering + reader mapping.
- **Justification**: Reader mapping (manifest → board) and board structure/reuse-seam are covered by Vitest unit tests; visual layout + splitter drag verified manually. Transcript rendering is the existing, already-tested nested path.

## Risk Level
MEDIUM — cross-cutting (reader + webview) with a new UI component, but bounded: agent transcripts reuse the existing nested machinery, the data is already on disk, and absent `workflowProgress` degrades to current behavior.
