# Proposal: restore-terminal-sessions

## Why

AT v0.12.2 loses editor-tab terminals on Cmd+R window reload (PTY killed by `TerminalEditorProvider.onDidDispose`) and loses every terminal's scrollback + metadata on full VS Code restart (no persistence layer). Sidebar/panel L1 already works via the scrollback cache. This change closes both gaps using VS Code core's own restore architecture.

## Appetite

L (≤2w) — multi-file change touching session lifecycle, IPC, persistence, plus new extension-host deps.

## Scope

### In scope

- **Phase A — Editor tab survives window reload**: `WebviewPanelSerializer` registration for `anywhereTerminal.editor`; stable `panelId` persisted via `webview.setState`; live editor panels tracked in `workspaceState`; grace-period destroy in `TerminalEditorProvider.onDidDispose` cancelled when the serializer revives.
- **Phase B — Cross-restart buffer restore**: extension-host headless `xterm` mirror per session; `SerializeAddon`-driven snapshots persisted to `workspaceState`; activate-time hydrate consumed by sidebar/panel providers + editor serializer; restore divider written to xterm on revive.
- Session metadata persisted: `viewLocation`, `terminalNumber`, `customName`, `shell`, `shellArgs`, initial `cwd`, latest `currentCwd`, `cols`, `rows`.
- Eviction: 7-day age cutoff, 20-snapshot cap per workspace, 1MB serialized buffer per snapshot.
- Setting: `anywhereTerminal.sessionRestore.enabled` (default `true`) as kill-switch.
- Tests: unit (scheduleDestroy + cancel, eviction, snapshot record schema) and integration (sidebar/panel/editor cross-restart).

### Out of scope

- **Tmux/screen/zellij opt-in (Phase C from source plan)** — true process revive. Deferred to a future change per the source plan's own recommendation; needs a different decision matrix and cross-platform fallbacks.
- **Remote-SSH terminals** — per `docs/PLAN.md §11`.
- **Snapshot compression** (gzip/lz-string) — defer until empirical bloat observed.
- **Cross-workspace / global persistence** — terminal sessions stay workspace-scoped.
- **Settings UI for snapshot caps** — hard-coded defaults; tunable later if needed.
- **Restoring split layouts that reference removed sessions** — existing `WebviewStateStore` handles split-tree pruning already.

## Capabilities

1. **editor-tab-reload-resilience** — Editor-area terminals survive `workbench.action.reloadWindow` (Cmd+R) with PTY alive and scrollback unchanged, mirroring sidebar/panel behavior.
2. **cross-restart-session-restore** — On extension-host startup, terminals from the prior session are recreated with their serialized buffer, custom name, view location, and tracked cwd; the new PTY is a fresh shell with a `─── restored — last update at HH:MM ───` divider written by the headless mirror.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — terminals reappear after restart; new divider line; new setting `anywhereTerminal.sessionRestore.enabled`.
- **E2E required?** NOT REQUIRED — `asimov/project.md` declares E2E `N/A`. Coverage via Vitest unit tests + manual matrix (sidebar / panel / editor × reload / restart) documented in tasks.md.
- **Justification**: AT has no E2E harness; integration tests under `src/` validate `SessionManager`, the serializer, and the cross-restart hydrate path against mocked `workspaceState`/webview APIs.

## Risk Level

MEDIUM — new extension-host deps (`@xterm/headless`, `@xterm/addon-serialize`) and the lifecycle edit to `TerminalEditorProvider.onDidDispose` are blast-radius changes. Each is independently kill-switchable: deps are dynamically imported only when `sessionRestore.enabled = true`; the grace-period destroy is observably equivalent to the current immediate destroy when no serializer revives within the window.
