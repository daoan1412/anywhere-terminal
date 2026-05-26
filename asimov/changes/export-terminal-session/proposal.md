# Proposal: export-terminal-session

## Why

Users want to save terminal output to share, archive, or grep — and ideally to extract *just one command + its result*, not paste the whole scrollback. PLAN.md §5.4 (top quick-win #1) framed this as a 1-day full-buffer dump; user feedback at Gate 1 escalated scope to per-command export via shell integration. This planted-flag feature has no equivalent in VS Code core (`vscode#44302`-era niche). See `discovery.md` Options for rejected alternatives.

## Appetite

**L** (≤2w) — Originally **S** in PLAN.md §5.4 (whole buffer, 1 day); escalated at Gate 1 to per-command tracking via OSC 633 + shell-integration script injection + new IPC for full webview scrollback dump. Realistic 8–12 working days including multi-shell smoke testing.

## Scope

### In scope

- Three command-palette entries: `Export Buffer to File…`, `Export Last Command Output…`, `Export Command…` (picker).
- OSC 633 marker parsing (A/B/C/D/E + existing P) → in-memory command list per session with eviction.
- Auto-injection of VS Code's shell-integration scripts for bash, zsh, fish, pwsh (macOS/Linux); pwsh on Windows.
- New IPC round-trip to dump full xterm.js scrollback (~5000 lines) from webview to extension on demand.
- ANSI stripping by default via `strip-ansi`; raw-ANSI option offered through save-dialog filter.
- Honest UX: informative toast when shell integration isn't active and per-command commands are invoked.

### Out of scope

- Heuristic prompt detection without OSC markers (rejected as Option C-alt in `discovery.md`).
- Cmd.exe / Git Bash on Windows beyond what VS Code's scripts already support.
- HTML / asciinema `.cast` export formats — text only for v1.
- "Run Recent Command" or "Copy Last Output" parity with VS Code's integrated terminal (separate change if demanded).
- Automatic upload, sync, cloud sharing.
- Multi-pane "export all panes" — focused pane / active session only.

## Capabilities

1. **shell-integration-tracker** — Parse OSC 633 markers and maintain a per-session list of executed commands with bounded memory.
2. **webview-scrollback-dump** — New IPC contract to retrieve the full xterm.js scrollback from the webview on demand.
3. **terminal-session-export** — User-facing commands that combine buffer/command data with `showSaveDialog` to write `.txt`/`.log` files.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — three new command-palette entries, one save dialog, one quickpick, two new info toasts.
- **E2E required?** NOT REQUIRED — project has no E2E infrastructure (`asimov/project.md` §Commands → E2E: N/A). Verify via unit tests + manual smoke (`Verify: manual …` on UI tasks). If E2E is added later, the surfaces here are first candidates.
- **Justification**: extension uses Mocha+@vscode/test-cli for integration paths and Vitest for unit; UI surface is small enough that targeted manual smoke per shell is the lowest-effort coverage.

## Risk Level

**MEDIUM** — Multi-shell injection is the principal risk (each shell has its own rc loading dance and Windows differs); OSC parser changes touch a hot path; new IPC adds a round-trip and a session-dispose race window. All risks have actionable mitigations in `design.md` Risk Map. No platform-breaking changes; degradation path exists when shell integration fails.
