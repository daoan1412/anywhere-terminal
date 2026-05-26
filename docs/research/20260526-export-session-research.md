---
topic: export-session-research
created-by: research for anywhere-terminal export-scope decision (single-command vs whole-buffer)
date: 2026-05-26
libraries: [microsoft/vscode, strip-ansi, ansi-to-html, wezterm, kitty, iterm2, warp]
used-by: []
---

# Research: export-session-research

## Answers
- **Can export just one command and its result?** Yes, but only when the terminal has **semantic command boundaries**. In VS Code this means shell integration is active and the stream contains OSC markers; without those markers, reliable per-command export is not feasible and the extension should fall back to whole-buffer export or user-selected ranges.
- **What is OSC 633?** VS Code’s custom shell-integration protocol. The key markers are `A` prompt start, `B` prompt end / command input start, `C` pre-execution, `D` command finished with optional exit code, `E` explicit command line with optional nonce, and `P` property updates such as `Cwd`.
- **Which shells ship integration scripts and how is it activated?** VS Code supports **bash, fish, pwsh, zsh** on Linux/macOS and **Git Bash, pwsh** on Windows. It auto-injects arguments/env on launch, and also supports manual sourcing via `code --locate-shell-integration-path <shell>`.
- **Can a third-party terminal extension inject/parse OSC 633?** In VS Code, not through a public API; the injector/parser is internal to the integrated terminal. A terminal app/extension that owns its own PTY can source the MIT-licensed scripts or implement OSC parsing itself, but a VS Code extension cannot replace the built-in injection path.
- **What’s the best scope choice?** For lowest risk: whole-buffer export. Best UX/value balance: whole-buffer + manual range. Best automation: per-command via OSC 633 / semantic blocks.

## Recommended Approach
| Option | User action | Extension work | Risk |
|---|---|---|---|
| **A. Whole buffer** | Pick a terminal session and export all output | Read the buffer, strip or preserve ANSI | Lowest; simplest; no command boundaries needed |
| **B. Whole buffer + manual range** | Select text / click a block, export selection | Preserve selection metadata and copy/export the chosen rows | Medium; requires UX for range selection and careful ANSI handling |
| **C. Per-command via OSC 633** | Run in a shell with integration enabled | Parse `A/B/C/D/E/P` markers, track command objects, stitch output by command | Highest payoff, highest complexity; misses unsupported shells, subshells, and untrusted output |

- If command-level export is a must, implement **C** as an enhancement on top of **B**, not a replacement.
- If the goal is a dependable first release, ship **A** first and add **B** next.

## Platform-Specific Setup
### VS Code shell integration
- Source: [VS Code terminal shell integration docs](https://code.visualstudio.com/docs/terminal/shell-integration) and [vscode-docs shell integration](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/shell-integration.md).
- Activation: automatic injection at terminal launch; disable with `terminal.integrated.shellIntegration.enabled = false`.
- Manual setup examples use `code --locate-shell-integration-path bash|fish|pwsh|zsh`.

### OSC 633 details
- `A` prompt start
- `B` command input start / prompt end
- `C` command executed / output starts
- `D` command finished, optional exit code
- `E` explicit command line, optional nonce
- `P` properties like `Cwd`, `IsWindows`, `HasRichCommandDetection`
- Internal parser: `ShellIntegrationAddon` plus `CommandDetectionCapability`, `CwdDetectionCapability`, etc.

### Legacy / interoperable protocols
- **OSC 133 (FinalTerm)**: supported by VS Code, iTerm2, WezTerm, Kitty; de facto semantic prompt standard.
- **OSC 1337 (iTerm2)**: `CurrentDir`, `SetMark`, user vars, and other metadata.

## Usage Examples
- **VS Code built-ins**
  - `workbench.action.terminal.runRecentCommand` — run recent command picker.
  - `workbench.action.terminal.copyLastCommandOutput` — copies the last command’s output from the terminal capability store.
  - Public API surface: `TerminalShellIntegration.executeCommand()`, `onDidStartTerminalShellExecution`, `onDidEndTerminalShellExecution`, and `execution.read()` for streaming output.
- **Open-source extension examples**
  - `microsoft/vscode-extension-samples` chat-sample reads terminal output via `execution.read()` after `executeCommand()`.
  - `RooCodeInc/Roo-Code` listens to `onDidStartTerminalShellExecution` and streams command output.
  - `microsoft/vscode/extensions/git/src/terminal.ts` reacts to `onDidEndTerminalShellExecution` for command-aware automation.

## Gotchas & Constraints
- Heuristic prompt regexes fail on multiline prompts, localized/custom prompts, nested shells, and commands whose output resembles prompts.
- OSC 633 command boundaries are only trustworthy when emitted by the shell integration script; the nonce/property mechanism exists to reduce spoofing.
- VS Code shell integration is shell-launch-time injection; it does not retroactively annotate existing scrollback.
- In Warp, the terminal UX is block-based rather than raw-buffer based, so a single command’s output is naturally a block; in WezTerm/iTerm2/Kitty, OSC 133 marks make prompt navigation and per-command output selection possible.

## Alternatives / Reference Implementations
- **WezTerm**: uses OSC 133 + OSC 7 + OSC 1337; docs describe jumping to prompts and selecting a command’s full output. Auto-activates on some packaged builds.
- **iTerm2**: FinalTerm-style OSC 133 with richer OSC 1337 metadata; supports captured output and command selection.
- **Kitty**: supports OSC 133 prompt markers and can open last command output in a pager; also accepts optional command-line metadata on `OSC 133;C`.
- **Warp**: block-based terminal; each command/output pair is a block that can be copied, searched, and navigated independently.

## strip-ansi and ANSI-preserving output
- **strip-ansi**: current npm search result shows **v7.2.0**, published ~2 months ago, maintained by **sindresorhus**, with **1 dependency** and **10,555 dependents**. The accessible sources did **not** expose the exact gzipped/unpacked size.
- **ansi-to-html**: current npm search result shows **v0.7.2**, published ~4 years ago, with **310 dependents**; it appears effectively low-maintenance.
- **Practical implication**: for text export, `strip-ansi` is the lightweight default; for visual fidelity, prefer HTML rendering or a replay-oriented format (e.g. cast-style logs) instead of stripping escape codes.

## Gaps
- I did not find a public VS Code API that lets an extension inject OSC 633 into another extension’s terminal session.
- I did not verify an exact package size for `strip-ansi` from accessible sources.
- I did not find a standalone open-source xterm.js addon that implements generic per-command capture; the practical examples I found are VS Code extensions using terminal shell integration APIs.

## Confidence
- **High** for VS Code shell-integration behavior, supported shells, command IDs, and OSC 633 semantics.
- **Medium** for size/maintenance notes on npm packages because accessible sources exposed versions and maintenance freshness but not exact package size.

## Sources
- [VS Code terminal shell integration docs](https://code.visualstudio.com/docs/terminal/shell-integration)
- [vscode-docs shell integration page](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/shell-integration.md)
- [VS Code shell integration injector](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/terminalEnvironment.ts)
- [VS Code CLI locate-shell-integration-path](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/server.cli.ts)
- [VS Code command IDs: run recent / copy last command output](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/history/common/terminal.history.ts)
- [VS Code clipboard contribution for last command output](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts)
- [Ext host terminal shell integration API](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostTerminalShellIntegration.ts)
- [WezTerm shell integration docs](https://github.com/wezterm/wezterm/blob/main/docs/shell-integration.md)
- [Kitty shell integration docs](https://github.com/kovidgoyal/kitty/blob/master/docs/shell-integration.rst)
- [iTerm2 escape codes docs](https://iterm2.com/documentation-escape-codes.html)
- [Warp terminal blocks docs](https://docs.warp.dev/terminal/blocks/)
- [Warp keyboard shortcuts docs](https://docs.warp.dev/getting-started/keyboard-shortcuts/)
- [strip-ansi npm search result](https://www.npmjs.com/package/strip-ansi)
- [ansi-to-html npm search result](https://www.npmjs.com/package/ansi-to-html)
