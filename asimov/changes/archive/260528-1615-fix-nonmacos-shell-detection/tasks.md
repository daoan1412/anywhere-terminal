## 1. Core shell detection (pty-integration)

- [x] 1_1 Make `detectShell` / `validateShell` / `getShellArgs` platform-aware
  - **Deps**: none
  - **Refs**: specs/pty-integration/spec.md (Shell Detection, Shell Validation, Shell Arguments); design.md D1, D2, D4, D5
  - **Scope**: src/pty/PtyManager.ts, src/pty/PtyManager.test.ts
  - **Acceptance**:
    - Outcome: `detectShell('win32', {ComSpec:'C:\\Windows\\System32\\cmd.exe'}, '')` returns `{shell:'C:\\Windows\\System32\\cmd.exe', args:[]}` without throwing; `validateShell(existingFile,'win32')` is `true` even without an exec bit; macOS no-arg behavior (`$SHELL`→`/bin/zsh`→…, `--login`) is unchanged; `vscode.env.shell` (when non-empty) wins over the chain.
    - Verify: unit src/pty/PtyManager.test.ts
  - **Plan**:
    1. Add `platform`/`env`/`vscodeShell` optional params (defaults `process.platform`/`process.env`/`vscode.env.shell`) per design.md D5 Interfaces; replace `SHELL_FALLBACK_CHAIN` with `SHELL_FALLBACK_CHAINS` for darwin/linux and a win32 default from `env.ComSpec ?? env.COMSPEC ?? "cmd.exe"`.
    2. Rewrite resolution order: vscodeShell (if non-empty) → env hint (`SHELL` non-win32 / `ComSpec` win32) → platform chain; return first that passes `validateShell`; if none, return the platform default unconditionally (D4 — do not throw).
    3. Branch `validateShell` on platform: win32 = `stat.isFile()` only; POSIX = existing `isFile() && (mode & 0o111)`. Branch `getShellArgs(shellPath, platform)`: `--login` only for posix zsh/bash basenames; `[]` for win32 shells + sh.
    4. Update PtyManager.test.ts: add win32 (cmd via ComSpec, exec-bit-less validation, no `--login`) + linux (`/bin/bash` chain) cases via injected params; replace the old "throws ShellNotFoundError" case with the D4 unconditional-default assertion; keep all existing macOS cases green.

## 2. Per-platform settings (extension-settings)

- [x] 2_1 Add `shell.windows` + `shell.linux` settings to the manifest
  - **Deps**: none
  - **Refs**: specs/extension-settings/spec.md (settings-schema); design.md D3
  - **Scope**: package.json
  - **Acceptance**:
    - Outcome: `contributes.configuration.properties` contains `anywhereTerminal.shell.windows` and `anywhereTerminal.shell.linux` (string, default `""`, `scope: machine`) with auto-detect descriptions; `shell.macOS` description unchanged in meaning.
    - Verify: manual — open Settings, search "anywhereTerminal", confirm shell.windows + shell.linux appear
  - **Plan**:
    1. After the `anywhereTerminal.shell.macOS` block, add the two keys mirroring its shape (type/default/scope) with Windows- and Linux-specific descriptions.

- [x] 2_2 Select the shell setting key by `process.platform` in SettingsReader
  - **Deps**: 1_1, 2_1
  - **Refs**: specs/extension-settings/spec.md (settings-reader); design.md D3
  - **Scope**: src/settings/SettingsReader.ts, src/settings/SettingsReader.test.ts
  - **Acceptance**:
    - Outcome: `readTerminalSettings()` reads `shell.windows` on win32 / `shell.linux` on linux / `shell.macOS` otherwise; a non-empty platform key overrides auto-detect; empty falls through to `PtyManager.detectShell()`.
    - Verify: unit src/settings/SettingsReader.test.ts
  - **Plan**:
    1. In `readTerminalSettings`, compute the platform key (`win32`→`shell.windows`, `linux`→`shell.linux`, else `shell.macOS`) and pass `config.get<string>(key)` into `resolveShell`; update the doc comment.
    2. Add SettingsReader.test.ts cases asserting the win32/linux/darwin key is read (mock `process.platform` or inject) and that a set value overrides detection.

## 3. Docs

- [x] 3_1 Update README platform support
  - **Deps**: 1_1
  - **Refs**: proposal.md (Scope); specs/extension-settings/spec.md (settings-schema)
  - **Scope**: README.md
  - **Acceptance**:
    - Outcome: README no longer states macOS-only shell support; documents `shell.windows`/`shell.linux` and that detection uses `vscode.env.shell` + per-platform fallback. The "Requirements" line and platform badge reflect Windows/Linux support.
    - Verify: none — docs-only
  - **Plan**:
    1. Update the platform badge/Requirements ("macOS (Windows/Linux on the roadmap)") and add a short shell-resolution note covering the new settings and fallback order.
