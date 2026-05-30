# Proposal: fix-nonmacos-shell-detection

## Why
On Windows (and any host without `/bin/zsh|bash|sh`), opening a terminal throws `No valid shell found. Tried: /bin/zsh, /bin/bash, /bin/sh` — `detectShell()` is hardcoded for macOS and `validateShell()`'s Unix execute-bit check is invalid on Windows. The extension is unusable off macOS.

## Appetite
S (≤1d)

## Scope

### In scope
- Platform-aware shell resolution in `PtyManager.detectShell()` for win32 / linux / darwin.
- Use `vscode.env.shell` (VS Code's already-resolved default) as the primary source, honoring `terminal.integrated.defaultProfile` and remote hosts.
- Fix `validateShell()` to use existence-only checks on Windows (no exec-bit).
- Per-platform default args in `getShellArgs()` (no `--login` for cmd/powershell).
- New settings `anywhereTerminal.shell.windows` and `anywhereTerminal.shell.linux`; `resolveShell()` selects the key matching `process.platform`.
- Make `detectShell`/`validateShell`/`getShellArgs` accept injectable `platform`/`env` params so win32/linux branches are unit-testable on macOS CI.
- README platform table + Requirements update.

### Out of scope
- New runtime dependencies (`which`, `find-process`) — covered by `vscode.env.shell` + env fallback.
- Git Bash / WSL / Cygwin auto-discovery (users can set `shell.windows` explicitly).
- Shell-integration injection changes (already handles pwsh).
- Cross-restart persisted-shell behavior changes.

## Capabilities

1. **pty-integration** — platform-aware `detectShell`/`validateShell`/`getShellArgs`.
2. **extension-settings** — per-platform shell setting keys + platform-matched resolution.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — terminals open on Windows/Linux instead of erroring; two new Settings UI entries.
- **E2E required?** NOT REQUIRED
- **Justification**: The repo has no E2E harness (`asimov/project.md` § E2E = N/A). Platform branches are covered by unit tests with injected `platform`/`env`; real-Windows behavior is verified by a documented manual smoke test (cannot run Windows on macOS dev/CI).

## Risk Level
LOW — isolated to shell resolution; macOS path preserved unchanged; new behavior is unit-tested per platform and falls back to a guaranteed platform default rather than throwing.
