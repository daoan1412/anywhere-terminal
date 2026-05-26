---
change-id: export-terminal-session
created: 2026-05-26
status: partial — see "Deferred" section
---

# Smoke-test matrix — export-terminal-session

> Manual verification of the three new Command Palette entries
> (`Export Buffer to File…`, `Export Last Command Output…`, `Export Command…`)
> across the supported shell × platform combinations.

For each row, run a representative command (e.g. `ls -la && false`), then:

1. **Markers fire?** — confirm `OSC 633;D` shows up in the tracked-command list (toast appears with non-empty output when invoking `Export Last Command…`).
2. **Per-command export?** — `Export Last Command Output…` writes a non-empty file with the expected `$ <cmd>` header + `[exit N] [cwd …]` line + output body.
3. **Fallback?** — disable shell integration (e.g. start shell with `--noprofile --norc`) and confirm `Export Buffer to File…` still produces a non-empty file while `Export Last Command…` shows the help toast.

## Matrix

| Shell | Platform | Markers fire? | Per-command export? | Buffer fallback? | Notes |
|---|---|---|---|---|---|
| bash | macOS (arm64, /bin/bash 3.2) | ⏳ pending local test | ⏳ | ⏳ | macOS bash is GPLv2 3.2 — verify the vendored `shellIntegration-bash.sh` is bash 3.2-compatible (it should be — VS Code supports macOS). |
| zsh | macOS (arm64, /bin/zsh 5.9) | ⏳ pending local test | ⏳ | ⏳ | Most common default; highest-priority row to verify. |
| fish | macOS (arm64, brew install fish) | ⛔ not available locally | ⛔ | ⛔ | `fish` not installed on this dev machine; deferred. |
| pwsh | macOS (arm64) | ⛔ not available locally | ⛔ | ⛔ | PowerShell Core not installed; deferred. |
| bash | Linux (x86_64, Docker) | ⛔ not reachable from CI of this session | ⛔ | ⛔ | Requires Docker + manual extension load; deferred. |
| pwsh | Windows (x86_64, VM) | ⛔ not reachable | ⛔ | ⛔ | Requires Windows VM; deferred. |

## Deferred

The combinations marked ⛔ are deferred to a follow-up effort:

- **fish on macOS**: `brew install fish` then re-run rows above. Cheap to add — no architectural difference vs. zsh; primarily a confirmation that the `--init-command` flag forwards correctly.
- **pwsh on macOS**: `brew install --cask powershell` then re-run. Adds confidence that the `-noexit -command ". '...'"` injection is correct without needing a Windows VM.
- **bash on Linux**: a Docker session of `mcr.microsoft.com/devcontainers/base:ubuntu` with the extension installed via `code-server --install-extension` would cover this row.
- **pwsh on Windows**: production-critical row. Should be on the v1 release checklist.

## How to re-run a row manually

1. Open the extension in a fresh VS Code window (`F5` in the workspace, or `code --extensionDevelopmentPath=. /tmp/test-workspace`).
2. Open the AnyWhere Terminal sidebar / panel / editor with the target shell (set `SHELL=/path/to/<shell>` first if not the default).
3. Run `ls -la && false` (or any command with a non-zero exit code so we exercise `D;<code>` parsing).
4. Run `> AnyWhere Terminal: Export Last Command Output…` from the Command Palette. Save to `/tmp/test-row-<shell>-<platform>.txt`. Confirm the file contents match: `$ ls -la && false\n[exit 1] [cwd <cwd>]\n\n<output>`.
5. Run `> AnyWhere Terminal: Export Buffer to File…` and confirm a non-empty file lands.
6. Restart the shell with the opt-out flags (`bash --noprofile --norc`, `pwsh -NoProfile`). Re-run step 4 — the toast `"no tracked commands yet…"` should fire. Re-run step 5 — buffer export should still succeed.
7. Update the row in this file (`⏳` → `✓` / `✗`).

## Known limitations as of this matrix

- **Window reload**: tracked commands reset to `[]` on reload (design D6). The scrollback is restored from snapshot but the command list is not persisted. This is expected behaviour; the no-tracked-commands toast acknowledges it.
- **Custom shells (nu, sh, dash, ksh)**: no injection — `Export Buffer to File…` works, the per-command commands surface the help toast.
- **macOS bash 3.2**: the vendored bash script was tested by VS Code against macOS, so this should work, but if `OSC 633` markers fail to fire on `/bin/bash`, that's the most likely first-suspect.
