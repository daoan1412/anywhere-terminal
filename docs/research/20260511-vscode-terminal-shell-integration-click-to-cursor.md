---
topic: vscode-terminal-shell-integration-click-to-cursor
created-by: research for Anywhere Terminal click-to-cursor implementation
date: 2026-05-11
libraries: [vscode, xterm.js]
used-by: []
---

# Research: vscode-terminal-shell-integration-click-to-cursor

## Answers
- VS Code does **not** solve click-to-cursor by replaying long left-arrow sequences. The integrated terminal relies on xterm.js's built-in `altClickMovesCursor` behavior, while shell integration tracks the prompt/command state semantically.
- The semantic layer is OSC-based shell integration: VS Code parses FinalTerm-style `OSC 133 ; A/B/C/D` and its own richer `OSC 633` family, then converts those events into `CommandDetectionCapability` and `PromptInputModel` state.
- In practice, shell integration gives VS Code a trustworthy current-command model; xterm then handles a local alt-click reposition gesture instead of the extension synthesizing `\x1b[D` repeats.
- For shells with rich integration, VS Code prefers the private `633` path because it can carry explicit command lines, nonces, cwd, prompt metadata, and shell capabilities. The `133` path is still supported for compatibility.
- If shell integration is missing or the shell is not at a prompt, the safe behavior is to **not** emit cursor-move escape spam. VS Code's own docs warn that Alt/Option-click cursor movement may be unreliable depending on the shell.

## TL;DR
- Enable shell integration and model the prompt boundaries semantically; do not replay arrow-key sequences on every click.
- Use OSC 133 for compatibility and OSC 633 for richer command-line reporting and trust/nonce handling.
- Let xterm.js perform the alt-click cursor move locally; VS Code only toggles the option and styles the cursor for Alt-state feedback.
- Treat no-shell-integration, long-running output, scrollback, and TUI/alt-buffer states as no-op or selection-only cases.

## OSC 133 protocol summary
- VS Code documents/implements the FinalTerm-style prompt lifecycle as:
  - `\x1b]133;A\x07` — prompt start
  - `\x1b]133;B\x07` — command input start / prompt end
  - `\x1b]133;C\x07` — command executed; output is about to start
  - `\x1b]133;D[;<exitCode>]\x07` — command finished; exit code optional
- The checked-in shell scripts emit BEL-terminated sequences (`\a` / `\x07`) even though comments and docs call the terminator generically `ST`.
- `133;D` without an exit code means “no command was run” or equivalent empty-input/interrupt case.
- There are **no IDs** on the `133` path. Identity/trust is handled on the VS Code-specific `633` path instead.
- VS Code also supports related OSCs:
  - `OSC 633` — VS Code private shell integration protocol
  - `OSC 1337` — iTerm2-compatible cwd/mark support
  - `OSC 7` and `OSC 9;9` — cwd reporting fallbacks
- The richer `633` family mirrors `133` with extra payloads:
  - `633;A/B/C/D`
  - `633;E;<commandLine>[;<nonce>]`
  - `633;P;<Property>=<Value>` including `Cwd`, `HasRichCommandDetection`, `ContinuationPrompt`, `Prompt`, `PromptType`, `IsWindows`, and `Task`
  - `633;EnvJson`, `633;EnvSingleStart/Entry/End`, `633;SetMark`, `633;F/G/H/I` (some are explicitly marked unfinalized)
- VS Code prioritizes `633` over `133` when both are present.

## Shell integration injection
### Bash
- File: `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh`
- Launch injection: `--init-file {appRoot}/out/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh`
- Mechanism:
  - Guards recursion with `VSCODE_SHELL_INTEGRATION`.
  - Uses `PROMPT_COMMAND` / `preexec`-style DEBUG-trap logic to wrap prompts and capture command execution.
  - Emits `633;A/B/C/D/E/Cwd/Prompt/ContinuationPrompt/HasRichCommandDetection` and env-reporting sequences.
- Important env vars:
  - `VSCODE_INJECTION=1`
  - `VSCODE_NONCE`
  - `VSCODE_SHELL_ENV_REPORTING`
  - `VSCODE_PATH_PREFIX`
  - `VSCODE_PREVENT_SHELL_HISTORY`
  - `VSCODE_ENV_REPLACE`, `VSCODE_ENV_PREPEND`, `VSCODE_ENV_APPEND`

### Fish
- File: `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.fish`
- Launch injection: `--init-command 'source ".../shellIntegration.fish"'`
- Mechanism:
  - Uses fish events: `fish_preexec`, `fish_postexec`, `fish_cancel`, `fish_prompt`.
  - Emits `633;A/B/C/D/E` and env/cwd reporting.
  - Wraps the user prompt by copying `fish_prompt` and `fish_mode_prompt` when present.

### PowerShell / pwsh
- File: `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1`
- Launch injection:
  - pwsh: `. "{appRoot}/out/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1"`
  - Windows PowerShell: `try { . "...\shellIntegration.ps1" } catch {}...`
- Mechanism:
  - Replaces `Prompt`.
  - Hooks PSReadLine when available to emit `633;E` before execution and `633;C` at execution start.
  - Emits `633;A/B/D`, cwd, prompt type, shell capability, and env state.
  - Uses a nonce and strips it from the environment immediately after capture.

### Zsh
- Files:
  - `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh`
  - `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-profile.zsh`
  - `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-env.zsh`
  - `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-login.zsh`
- Launch injection:
  - VS Code points `ZDOTDIR` at a temporary directory and copies `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin` there.
- Mechanism:
  - Uses `add-zsh-hook precmd/preexec`.
  - Wraps `PS1`, `PS2`, and optionally `RPROMPT` with start/end markers.
  - Emits `633;A/B/C/D/E`, cwd, prompt type, continuation prompt, rich-detection flag, and env reporting.
- Notable behavior:
  - The temp `ZDOTDIR` approach is used so VS Code can source the user's real dotfiles without permanently changing shell startup behavior.

### Injection policy in Node-side launch code
- File: `src/vs/platform/terminal/node/terminalEnvironment.ts`
- `getShellIntegrationInjection(...)` decides whether to inject based on:
  - shell integration enabled setting
  - presence of an executable
  - feature-terminal exclusions unless forced
  - ignore-shell-integration flag
  - supported Windows build / ConPTY constraints
- It rewrites launch args and mixes in environment variables for the shell scripts.

## Click-to-cursor algorithm
### What VS Code actually does
- I did **not** find a custom VS Code mouse-click handler that computes absolute cursor moves from shell integration state.
- The browser-side integration simply passes `altClickMovesCursor` to xterm.js and changes the cursor styling while Alt is active.
- That means the actual click-to-cursor behavior lives in xterm.js selection handling, not in VS Code's terminal code.

### Practical flow
```text
terminal created
  -> xterm loaded with altClickMovesCursor enabled
  -> shell integration addon registers OSC 133 / 633 handlers
  -> command detection builds prompt/current-command model
  -> user Alt/Option-clicks
  -> xterm.js selection service decides whether this is an alt-click move gesture
     - only on a short click
     - only when selection is tiny / non-drag
     - only when the buffer is in a state where cursor movement is allowed
  -> xterm moves the cursor locally to the clicked cell
  -> VS Code shell integration state keeps prompt boundaries accurate
```

### Why this avoids the bug
- The extension is not supposed to emit `\x1b[D` N times per click.
- When the shell is busy or not at a prompt, the gesture should be ignored or reduced to a normal click/selection interaction, because there is no safe editable region to target.
- Shell integration gives you the current prompt/input boundary, so you can decide whether the clicked cell is inside an editable current-command region before moving anything.

## Edge cases
- **Multi-line prompts**
  - Bash/zsh/pwsh scripts emit explicit prompt start/end markers and continuation prompt metadata.
  - `PromptInputModel` stores `continuationPrompt` and stitches multi-line input back together.
- **Wrapped input lines**
  - `PromptInputModel._sync()` walks wrapped rows and reconstructs the logical command line.
- **Scrollback / scrolled viewport**
  - xterm.js's built-in alt-click move only fires in the live viewport path; if the buffer is scrolled back, it should not move the prompt cursor.
- **Alt buffer / TUI mode**
  - `CommandDetectionCapability` invalidates prompt state when the cursor moves unexpectedly and treats alt-buffer / clear-display cases carefully.
- **Long-running commands in progress**
  - This is the important bug case. Without a prompt boundary, a click should not synthesize movement into output. The semantic model should be in execute state, not input state.
- **Click during selection drag**
  - xterm.js only treats it as alt-click cursor movement if the gesture is short and the selection is effectively empty/small.

## Key file:line references
1. `src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts:147-150` — user-facing `terminal.integrated.altClickMovesCursor` description.
2. `src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts:216-223` — passes `altClickMovesCursor` into xterm.js at construction.
3. `src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts:535-549` — updates xterm option when config changes.
4. `src/vs/workbench/contrib/terminal/browser/media/terminal.css:193-196` — switches cursor to default while Alt is active.
5. `src/vs/workbench/contrib/terminal/browser/terminalTabbedView.ts:457-462` — toggles the `alt-active` class on keydown/keyup.
6. `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts:39-55` — defines the OSC 133 / 633 / 1337 namespaces.
7. `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts:64-88` — documents 133 prompt/command lifecycle sequences.
8. `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts:103-169` — documents the richer 633 prompt/command-line protocol.
9. `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts:367-376` — registers xterm OSC handlers for 633, 1337, 7, and 9.
10. `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts:438-618` — dispatches 633/133/633-properties into detection capabilities.
11. `src/vs/platform/terminal/common/capabilities/commandDetectionCapability.ts:252-427` — maps prompt/command markers into a current/full command model.
12. `src/vs/platform/terminal/common/capabilities/commandDetection/promptInputModel.ts:79-458` — reconstructs the current editable prompt input, cursor, and ghost text.
13. `src/vs/platform/terminal/node/terminalEnvironment.ts:53-60,108-279` — shell integration injection decision tree and per-shell arg rewriting.
14. `src/vs/platform/terminal/node/terminalEnvironment.ts:329-339` — launch args for bash, fish, pwsh, and zsh.
15. `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh:240-492` — bash hooks, prompt markers, command output start/end, and `PROMPT_COMMAND` wiring.
16. `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.fish:111-223` — fish OSC emitters and prompt hooks.
17. `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1:106-220` — PowerShell prompt replacement and PSReadLine execution hooks.
18. `src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh:156-330` — zsh prompt/start/end, env reporting, and `precmd`/`preexec` hooks.
19. `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts:475-495` — shell integration capability listeners and command-id plumbing.
20. `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts:975-1023` — waits for shell integration before `runCommand`, and avoids stale input behavior.
21. `src/vs/workbench/contrib/terminal/browser/terminalEscapeSequences.ts:9-88` — central escape-sequence constants for 133 / 633 and the protocol commentary.

## Pitfalls / things they got wrong initially
- The alt-click cursor feature is explicitly documented as potentially unreliable depending on the shell. VS Code exposes the setting, but the implementation is not a full semantic editor; it still depends on the terminal buffer behaving like an editable prompt.
- VS Code originally needed a richer private protocol (`633`) because FinalTerm-style `133` alone could not reliably provide command line text on all platforms, especially Windows/ConPTY.
- The `633;E` command-line message is required to be escaped carefully; semicolons and control characters are encoded, and the nonce is used to trust the line.
- The zsh injection path is more invasive than the other shells because it redirects `ZDOTDIR` to a temp directory and copies startup files; that can surprise users if mirrored naively.
- `CommandFinished` is intentionally tolerant of “empty prompt / ctrl+c” cases where no command was run.
- The browser code does not contain a bespoke click-to-cursor state machine; the movement behavior is delegated to xterm.js. If you want shell-aware click behavior, you will need to implement that yourself instead of expecting VS Code to expose a ready-made API.

## Minimal viable plan for our extension
1. **Bundle shell integration scripts** for bash, zsh, fish, and pwsh, using the VS Code injection pattern:
   - bash: `--init-file`
   - fish: `--init-command source ...`
   - pwsh: dot-source script in `-command`
   - zsh: temp `ZDOTDIR` + copied dotfiles
2. **Register xterm OSC handlers** for at least `133` and `633`.
   - Start with `A/B/C/D`
   - Add `633;E` and `633;P` for trustworthy command-line text and metadata
3. **Maintain a semantic prompt model**.
   - Track prompt start, command start, executed, finished, cwd, continuation prompt, and whether the shell is in `Input` vs `Execute` state.
4. **Implement click-to-cursor as a bounded action**.
   - Only reposition when the click is inside the current editable command region.
   - If shell integration is absent or the shell is executing, do nothing rather than replay arrows.
5. **Keep selection and TUI behavior safe**.
   - Respect selection drags, scrolled-back viewport, and alt-buffer/TUI sessions.
6. **Fallback behavior**.
   - No shell integration: disable click-to-cursor or make it selection-only.
   - Shell integration active but not at a prompt: ignore the click.
   - Shell integration active and at prompt: move cursor within the semantic bounds only.

## Recommended approach
- Copy VS Code's split: shell integration for semantics, xterm for the actual Alt-click gesture.
- Do not synthesize repeated left-arrow escape sequences at all.
- Use the current-command model to decide whether a click is allowed, and if it is, perform a bounded, local cursor reposition rather than sending literal arrows to the PTY.

## Gaps
- I did not find a custom VS Code-side click handler that uses OSC 133 state directly for cursor movement; the actual click gesture is handled by xterm.js.
- I did not verify the exact xterm.js SelectionService line numbers locally, only the public repository snippet showing the alt-click move condition.
- The official docs page was retrieved via web search/fetch summaries; I did not extract every paragraph verbatim.

## Confidence
- **High** for shell integration protocol, per-shell injection, and the VS Code/xterm option wiring — confirmed by source files and official docs.
- **Medium** for the exact click-to-cursor end-to-end behavior inside xterm.js — confirmed by the xterm.js public snippet, but not fully traced in the VS Code repo because VS Code delegates that part.

## Sources
- [VS Code Terminal Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)
- [VS Code Terminal Basics](https://code.visualstudio.com/docs/terminal/basics)
- [iTerm2 - Shell Integration Protocol Specification](https://gist.github.com/tep/e3f3d384de40dbda932577c7da576ec3)
- [Proprietary Escape Codes - iTerm2](https://iterm2.com/documentation-escape-codes.html)
- [VS Code shell integration docs source](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/shell-integration.md)
- [VS Code integrated terminal basics docs source](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/basics.md)
- [xterm.js SelectionService alt-click behavior](https://github.com/xtermjs/xterm.js/blob/master/src/browser/services/SelectionService.ts)
- [xterm.js altClickMovesCursor option docs](https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts)
