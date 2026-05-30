# Review Round 1 — fix-nonmacos-shell-detection

- **Date**: 2026-05-28
- **Reviewable lines**: ~157 (PtyManager.ts, SettingsReader.ts, package.json)
- **Agents spawned**: data-security, contracts, logic (logic = 1st attempt failed on a socket error; re-run completed)
- **Agents skipped**: frontend (no React/CSS/JSX changes)
- **Verdict**: WARN (0 BLOCK after adjudication)
- **Counts**: BLOCK 0 · WARN 1 (accepted, fixed) · SUGGEST 2 (deferred) + rebutted 1

> Process note: the re-run logic agent executed in a mode without the Agent tool and edited production files directly (outside a reviewer's mandate). Its edits were sound and verified (tsc + 1536 tests green) and are retained: `getPlatformShellKey` maps other POSIX → `shell.linux` (aligns with `getPosixChain` default); `getShellArgs` uses `path.posix.basename`; tests made host-independent; whitespace-env (`firstNonEmpty`) hardening.

## Findings

### [F1] Legacy `shell.macOS` ignored for non-macOS users after upgrade
- **Severity**: WARN (downgraded from agent's BLOCK) · **Confidence**: HIGH · **Priority**: P2
- **Agent**: contracts
- **File**: src/settings/SettingsReader.ts (getPlatformShellKey / readTerminalSettings)
- **Evidence**: Shell lookup moved from the single `shell.macOS` key to the per-platform key. A Windows/Linux user who set `shell.macOS` as a workaround (the only key that existed, and the only way the terminal worked on Windows pre-fix) now has it ignored.
- **Impact**: Bounded. Post-fix auto-detect yields a working shell on all platforms, so no user is left without a terminal — at worst a Windows early-adopter gets auto-detected pwsh/cmd instead of their hand-set path.
- **Triage**: ACCEPTED (as WARN). Refuted the BLOCK framing: the extension was documented macOS-only (`README` badge + "Windows/Linux on the roadmap"), and the key is labeled "for macOS", so non-macOS use relied on a platform-agnostic quirk — not a supported contract. Rejected a code-level back-compat shim (a permanent `shell.macOS`-affects-Windows fallback is a confusing cross-platform hack).
- **Status**: fixed
- **Fix**: README migration note added under the shell-settings table directing non-macOS users to move the value to `shell.linux` / `shell.windows`.

### [F2] `shell.args: []` default not honored for custom platform shells
- **Severity**: WARN · **Confidence**: HIGH · **Priority**: P3
- **Agent**: contracts
- **File**: src/settings/SettingsReader.ts:215 (resolveShell)
- **Evidence**: When a custom shell is set, `resolveShell` returns `shellArgs: customArgs ?? []`, so default `shell.args: []` yields `[]` rather than derived defaults (e.g. `--login`).
- **Triage**: REBUTTED. This `customShell → customArgs ?? []` branch is **unchanged pre-existing behavior** — this change only added the `platform` parameter. Per review rules, unchanged code is not flagged (non-critical). The "use defaults" phrasing applies to the auto-detect path, which is honored. Out of scope for this change.
- **Status**: rejected

### [F3] Custom/restored shell path bypasses `validateShell` before spawn
- **Severity**: SUGGEST · **Confidence**: MEDIUM · **Priority**: P4
- **Agent**: data-security
- **File**: src/settings/SettingsReader.ts (resolveShell) / src/session/SessionManager.ts (restore path)
- **Evidence**: `validateShell` runs only inside `detectShell`'s auto-detect loop; a custom `shell.<platform>` setting or a snapshot-restored shell goes straight to `node-pty.spawn`.
- **Triage**: NOTED, won't fix. Pre-existing for the custom-shell path; both sources are trusted (machine-scoped setting; `workspaceState`/`storageUri` snapshot — not repo-authored). A bad path produces a spawn failure, not a security issue. Graceful-degradation hardening only.
- **Status**: deferred

### [F4] Last-resort `"cmd.exe"` literal is not an absolute path
- **Severity**: SUGGEST · **Confidence**: MEDIUM · **Priority**: P5
- **Agent**: data-security
- **File**: src/pty/PtyManager.ts (WINDOWS_DEFAULT_SHELL / detectShell fallback)
- **Evidence**: The unconditional Windows fallback is the bare string `"cmd.exe"`, resolved by Windows process search order (can include the cwd = workspace root). Only reachable when `%ComSpec%` is entirely unset — abnormal on a functioning Windows install. POSIX side is safe (absolute `/bin/sh`).
- **Triage**: NOTED, deferred. Trigger is an abnormal environment (`%ComSpec%` unset). Current unit tests assert the literal `"cmd.exe"` fallback; an absolute-path default (`%SystemRoot%\System32\cmd.exe`) would be a follow-up hardening with its own test update. SUGGEST severity, not auto-fixed.
- **Status**: deferred

## Verification Question Answers (summary)
- detectShell never throws on supported platforms; last-resort POSIX `/bin/sh`, Windows `%ComSpec% ?? cmd.exe`. ✓
- `firstNonEmpty` trims/skips empty/whitespace/undefined for vscodeShell/$SHELL/ComSpec. ✓
- getShellArgs handles Windows backslash paths via `path.posix.basename`; `bash.exe → --login`, `pwsh.exe → []`. ✓
- Shell-path trust model sound: shell settings are `scope: machine` → a malicious workspace `.vscode/settings.json` cannot redirect the spawned shell. ✓
- `readTerminalSettings(platform?)` is a backward-compatible optional-param addition. ✓

## Session IDs
- data-security: review-fix-nonmacos-shell-detection-datasec (a02b5a7e679bd9251)
- logic: review-fix-nonmacos-shell-detection-logic2 (ae85a020bac975937) — note: 1st attempt a78d59de2b5d44f1d failed (socket)
- contracts: review-fix-nonmacos-shell-detection-contracts (ab84a0dedb0600e8b)
- frontend: not-spawned
