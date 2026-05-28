# Design: fix-nonmacos-shell-detection

## Decisions

### D1: `vscode.env.shell` is the primary detection source

`detectShell` consults `vscode.env.shell` before any hardcoded chain. VS Code has already run its full platform detection (`src/vs/base/node/shell.ts` + `terminalProfiles.ts`) and the value is *overridden by `terminal.integrated.defaultProfile`* and reflects the **remote** host on SSH/WSL/Codespaces. This gives correct results across all platforms with zero new dependencies.

Rejected: porting inshellisense-style `which`/git-bash discovery (Option A) — adds runtime deps and reimplements detection VS Code already exposes. Empty string is documented as "no shell" → treated as "skip this candidate", fall through to the env hint + platform chain.

### D2: `validateShell` skips the execute-bit check on Windows

POSIX validation keeps `stat.isFile() && (stat.mode & 0o111) !== 0`. Windows validation is existence-only (`stat.isFile()`). Node on Windows derives `stat.mode` from the read-only attribute and does **not** set Unix execute bits, so `(mode & 0o111)` is `0` for valid `.exe` shells — the current check is the direct cause of the false `ShellNotFoundError` even when a correct path is found. Sibling `vscode-sidebar-terminal` performs no exec-bit check at all and spawns successfully.

### D3: Per-platform setting keys selected by `process.platform`

Add `anywhereTerminal.shell.windows` and `anywhereTerminal.shell.linux` alongside the existing `shell.macOS` (all `scope: machine`). `readTerminalSettings()` picks the key for the running platform; the other two keys are inert on that platform. Avoids a single mislabeled `shell.macOS` key doing duty on Windows/Linux.

### D4: Never throw on supported platforms — return a guaranteed default

When no candidate validates, a last-resort default is returned **unconditionally** (not validated, not thrown): POSIX returns the final chain entry `/bin/sh`; Windows returns `%ComSpec%` (falling back to the literal `cmd.exe`). This directly fixes the reported error. `ShellNotFoundError` and `ErrorCode.ShellNotFound` remain defined (referenced by `errors.ts`/tests) but `detectShell` no longer throws them under normal operation — the existing `PtyManager.test.ts` "throws ShellNotFoundError" case is updated to assert the new fallback behavior.

### D5: Injectable `platform` + `env` params for cross-platform unit tests

Windows/Linux branches must be testable on the macOS dev/CI box. Signatures take optional injected params defaulting to the real values:

## Interfaces

```ts
// src/pty/PtyManager.ts
export function detectShell(
  platform?: NodeJS.Platform,   // default process.platform
  env?: NodeJS.ProcessEnv,      // default process.env
  vscodeShell?: string,         // default vscode.env.shell
): { shell: string; args: string[] };

export function validateShell(
  shellPath: string,
  platform?: NodeJS.Platform,   // default process.platform
): boolean;

// internal — login flag derived from basename only (zsh/bash → --login), platform-independent
function getShellArgs(shellPath: string): string[];

const SHELL_FALLBACK_CHAINS: Record<"darwin" | "linux", readonly string[]>;
// darwin: ["/bin/zsh","/bin/bash","/bin/sh"]; linux: ["/bin/bash","/bin/sh"]
// posix last-resort = final chain entry "/bin/sh"; win32 default = env.ComSpec ?? env.COMSPEC ?? "cmd.exe"
```

`SessionManager.createSession()` (`SessionManager.ts:384`) and `SettingsReader.resolveShell()` call `detectShell()` with no args — the defaults preserve their current behavior, so no caller change is required beyond SettingsReader's platform-key selection (D3).

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| `detectShell` darwin branch | Regression on the working macOS path | Keep darwin chain + `--login` identical; existing macOS unit cases in `PtyManager.test.ts` must stay green |
| Windows behavior | Cannot run Windows on macOS CI | Unit-test win32 branch via injected `platform`/`env` (D5); document a manual Windows smoke test in tasks |
| `validateShell` win32 | Over-permissive (accepts any existing file) | Acceptable — matches VS Code/sibling; spawn failure surfaces naturally; POSIX keeps strict check |
| `vscode.env.shell` empty | Returns `""` in non-shell hosts | Treat empty as skip → env hint + platform default chain (D1, D4) |
