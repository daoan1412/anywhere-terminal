# Proposal: enhance-vault-sessions

## Why
The AI Vault lists past coding sessions but is static (manual refresh only), shows no per-message model/cost or session branch, and offers no way to rename a session. This change makes the vault live and more informative without ever mutating the agents' own session stores.

## Appetite
M (≤3d) — 4 focused capabilities over existing vault infra; reuses the FS-watcher pool and detail readers.

## Scope

### In scope
- Rename a vault session (any agent) via a safe sidecar registry; custom name overrides the derived title in list + preview.
- Show per-assistant-message model + token usage (and context-window where the agent records it) in the preview.
- Show the session's git branch as a preview-header chip (agents that record it: Claude, Codex).
- Auto-refresh the vault list when any agent's on-disk store changes (no manual click needed); manual refresh stays as a fallback.
- Live-follow the previewed session: auto-scroll new messages when at bottom, show a "N new messages" pill when scrolled up; stop on close.

### Out of scope
- Writing custom names back into agent-owned files/DBs (Claude `custom-title`, Codex `session_index.jsonl`, OpenCode `session.title`) — deferred; sidecar only.
- Deriving OpenCode's git branch from its `directory` (no branch recorded; omit gracefully).
- True byte-offset incremental JSONL tailing (use debounced bounded re-read instead).
- New agents beyond claude/codex/opencode.

## Capabilities

1. **vault-session-rename** — assign/clear a custom name per session, persisted in extension global state keyed by `<agent>:<sessionId>`; overrides derived title. Never touches agent files.
2. **vault-metadata-display** — per-assistant-message model + token usage (+ context-window when recorded) and a session git-branch chip in the preview header.
3. **vault-auto-refresh** — FS-watcher-driven automatic list refresh on store change, debounced, reusing the incremental stale-while-revalidate path; non-disruptive to scroll/selection/open preview.
4. **vault-live-follow** — while a preview is open, watch that session and surface new messages: append+auto-scroll at bottom, "N new" pill when scrolled up.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — new Rename context-menu item + inline edit, per-message meta line, branch chip, auto-updating list, new-messages pill/auto-scroll in preview.
- **E2E required?** NOT REQUIRED — project has no E2E harness (project.md § E2E = N/A). Reader/registry logic covered by Vitest unit tests; watcher + webview UI verified manually.
- **Justification**: The behavioral core (metadata extraction, custom-name overlay, list merge) is unit-testable in the host; watcher timing and DOM interactions are manual-verify per existing vault practice.

## Risk Level
MEDIUM — filesystem watchers over user home stores (churn/cost) and live re-render on append; mitigated by reusing the debounced WatcherPool + incremental cached refresh + change-detection before re-render.
