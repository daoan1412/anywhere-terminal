# Proposal: redesign-vault-panel-ui

## Why

The AI Vault shipped as a functional flat list. `docs/research/vault.html` defines a refined design — real agent brand icons, grouping modes, single-line rows, right-click actions, and a content-rich session preview — that makes the vault scannable and genuinely useful. This change implements that design end-to-end.

## Appetite

L (≤2w)

## Scope

### In scope

- Replace codicon agent badges with **real inline brand SVGs** (Claude / Codex / OpenCode), normalized to `currentColor` and tinted by a per-agent accent.
- **Single-line grid rows** (badge | title | cwd-chip | time) with an icon-only Resume action revealed on hover/focus; **remove the fork action from rows**.
- **Grouping control** with three modes — Recent (flat), Agent (grouped + counts), Folder (collapsible, cwd-chip dropped) — applied client-side; selected mode persists.
- **Right-click row context menu** (Resume in New Tab, Open, Reveal in Finder, Copy File Path, Copy Resume Command, Open Working Directory), with file-targeting items shown only for file-backed sessions.
- **Floating session-preview overlay** opened on row activation: first prompt, recent-activity timeline (tool / subagent calls), latest assistant message, and activity stats; closes on Esc / click-outside.
- **On-demand per-agent session-detail read** (Claude: tail jsonl; Codex/OpenCode: query SQLite message rows), bounded + defensive, behind a new IPC message.
- Restyle empty / no-match / unreadable-notice states to match the mockup.

### Out of scope

- No change to resume/launch mechanics, agent registry records, or the collapsible-above-file-tree composition (design D11 of the prior change).
- No transcript search — search stays over title / cwd / agent.
- No prefetch of details for the whole list (detail is read on-demand per row activation).
- Fork stays in the registry/launcher but is surfaced in no UI.

## Capabilities

1. **vault-panel** — UI redesign: real icons, grid rows, grouping modes, context menu, preview trigger, restyled states.
2. **vault-session-preview** — on-demand per-agent session-detail read + IPC contract + preview-overlay content rendering.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — the entire vault panel is restyled and gains grouping, a context menu, and a preview overlay.
- **E2E required?** NOT REQUIRED.
- **Justification**: `asimov/project.md` § Commands lists E2E as N/A. Host-side detail readers and the pure grouping function are covered by Vitest unit tests; the webview rendering is verified manually in the Extension Development Host.

## Risk Level

MEDIUM — per-agent transcript parsing is fragile and format-divergent across jsonl/SQLite; mitigated by bounded + defensive reads, a reusable substrate, and unit tests per reader.
