# Discovery: fix-nonmacos-shell-detection

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot | Done | direct read (in-session) |
| Internal Patterns | Done | direct read (in-session) |
| External Research | Done | reference projects in `/Users/huybuidac/Projects/ai-oss` + `microsoft/vscode` |
| Constraint Check | Done | direct read `package.json` |

> Research was performed in-session before the planning skill was invoked; findings are folded in here rather than re-delegated.

## Key Findings

### 1. Root cause — `detectShell()` is macOS-only

`ShellNotFoundError` is thrown by `detectShell()` (`src/pty/PtyManager.ts:135`) when the fallback chain exhausts. Four independent reasons it fails off macOS:

1. **Hardcoded POSIX chain** (`PtyManager.ts:66`): `["/bin/zsh", "/bin/bash", "/bin/sh"]` — none exist on Windows.
2. **`$SHELL` is a Unix concept** (`PtyManager.ts:119`): step 1 reads `process.env.SHELL`, unset on native Windows (Git Bash aside).
3. **`validateShell()` execute-bit check is invalid on Windows** (`PtyManager.ts:193`): `stat.isFile() && (stat.mode & 0o111) !== 0`. Node on Windows does not set Unix execute bits — `powershell.exe` reports mode `~0o666`, so validation returns `false` even with a correct path. **This is a second, independent bug** — fixing the chain alone won't help on Windows.
4. **Settings only expose `shell.macOS`** (`package.json:56`, `SettingsReader.ts:75`): no `shell.windows`/`shell.linux`; `resolveShell()` reads only `shell.macOS`.

Two callers throw to the UI on failure: `SettingsReader.resolveShell()` (`SettingsReader.ts:205`) and `SessionManager.createSession()` (`SessionManager.ts:384`).

Linux mostly works (via `$SHELL` + `/bin/bash`/`/bin/sh`), but lacks a `shell.linux` key and prefers absent zsh. **Windows is the real breakage.**

### 2. Internal patterns already cross-platform

`ShellIntegrationInjector` already recognises `pwsh`/`pwsh.exe` and splits Windows paths correctly (`ShellIntegrationInjector.ts:85,104`). Many path/link modules branch on `process.platform === "win32"`. Only `detectShell`/`validateShell`/settings remain macOS-only.

### 3. `vscode.env.shell` — the most accurate source for an extension

`@types/vscode@1.105.0` (`index.d.ts:10791`): *"The detected default shell for the extension host, this is overridden by the `terminal.integrated.defaultProfile` setting... in environments that do not support a shell the value is the empty string."*

Since this extension runs inside VS Code, VS Code has already run its full platform detection. Benefits: respects the user's configured profile, returns the **remote** shell on SSH/WSL/Codespaces/Dev Containers, zero deps. Current code ignores it entirely.

### 4. Reference implementations (priority orders)

- **VS Code source** (`src/vs/base/node/shell.ts`): Unix = `$SHELL` → `userInfo().shell` (reads `/etc/passwd`) → `'sh'` → `/bin/bash` if `/bin/false`. Windows = PowerShell 7 → Windows PowerShell, or simple `getWindowsShell()` = `env['comspec'] || 'cmd.exe'` (`processes.ts:24`). Validation = file-existence, **never** exec-bit.
- **inshellisense** (Microsoft, node-pty): `shellExists = fs.existsSync(target) || which(target) != null` (`isterm/pty.ts:371`); git-bash discovery via `which("git.exe")` + ProgramFiles/scoop dirs (`utils/shell.ts:212`).
- **opencode** (`shell.ts:44`): `$SHELL ?? fallback()`; win32 = git-bash via `which("git")` → `process.env.COMSPEC || "cmd.exe"`; darwin = `/bin/zsh`; linux = `which("bash") || "/bin/sh"`.
- **vscode-sidebar-terminal** (sibling sidebar-terminal ext, `ConfigManager.ts:190`): `SHELL_<platform> setting || process.env.<COMSPEC|SHELL> || <default>` — **no exec-bit validation**, just spawn.

### 5. Constraint — minimal dependencies

`package.json` runtime deps = `strip-ansi` only. Adding `which`/`find-process` would be the first utility deps. Avoidable: `vscode.env.shell` + a platform `process.env` fallback covers the cases without new deps.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| `detectShell()` | macOS chain only | platform-aware + `vscode.env.shell` primary | Rewrite resolution |
| `validateShell()` | exec-bit check | win32 = existence-only | Branch on platform |
| `getShellArgs()` | `--login` for zsh/bash | no `--login` for cmd/powershell | Branch on shell/platform |
| Settings schema | `shell.macOS` | `shell.windows`, `shell.linux` | Add 2 keys + platform selection |
| `resolveShell()` | reads `shell.macOS` | reads platform-matched key | Wire platform selection |
| README | "macOS only" | document Win/Linux | Doc update |

## Options

### Option A — Add `which` + git-bash discovery (inshellisense-style)
Most thorough Windows coverage (finds Git Bash, PATH-resolved binaries). **Trade-off:** adds runtime deps (`which`), more code/tests, over-engineered for an extension that can ask VS Code directly.

### Option B — Layered resolution: `vscode.env.shell` primary → platform fallback (Recommended)
User setting (`shell.<platform>`) → `vscode.env.shell` (if non-empty) → platform `process.env` fallback (`COMSPEC`/`SHELL`) → hardcoded default per platform. Plus fix `validateShell` to skip exec-bit on win32. **Why:** reuses VS Code's own detection (respects `defaultProfile` + remote hosts), zero new deps, minimal code, covers Windows/Linux/macOS. Matches the sibling `vscode-sidebar-terminal` pattern.

### Option C — Only fix the fallback chain + validateShell
Smallest change. **Trade-off:** ignores `vscode.env.shell`, so won't honor the user's VS Code profile or remote shell — leaves the most accurate source on the table.

## Risks

1. **macOS regression** — existing working path must not change. Mitigation: keep darwin branch behavior + `--login` identical; existing `PtyManager.test.ts` macOS cases must still pass.
2. **Cannot test real Windows on this machine** — Mitigation: make `detectShell`/`validateShell` accept an injected `platform` (and env) param so unit tests exercise win32/linux branches deterministically; document manual Windows smoke test in tasks.
3. **`vscode.env.shell` empty string** — documented possible. Mitigation: treat empty as "not available" and fall through to the platform fallback chain.
