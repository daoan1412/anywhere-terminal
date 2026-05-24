# What Users Want in a VSCode Terminal Extension — Competitive Analysis (May 2026)

## TL;DR
- The biggest opportunity is **persistent terminal sessions, true tab-autocomplete that doesn't fight the shell, and AI features that actually work over remote SSH** — these are explicitly punted by Microsoft to extensions, are the highest-traffic complaint clusters, and current extensions only partially address them.
- VSCode's built-in terminal has absorbed most basic UX extensions (tabs, split, profiles), so a new extension must compete on **deep features Microsoft cannot or will not ship**: cross-restart session restore with reattach, Warp-style command blocks/output management, an agentic terminal that reads remote/SSH output reliably, and per-shell completion engines (fish/zsh-style).
- Top pain points (frequency-ranked): (1) terminal sessions die on reload/restart, (2) paste throttling and Ctrl+C/Ctrl+V copy-paste conflicts, (3) Remote-SSH terminal lag/disconnects, (4) terminal output rendering chokes on large logs, (5) the new terminal Suggest feature interferes with native shell tab-complete, (6) AI agents (`@terminal`/Copilot agent mode) cannot read SSH terminal output, and (7) no vertical/flexible split or detachable terminal windows.

## Key Findings

### 1. Top Pain Points (ranked by frequency and engagement)

**1. Persistent terminals across reloads, restarts, and SSH drops** — the single most-cited unsolved category.
- microsoft/vscode Issue #44302 ("Restore terminal sessions between restarts") has been open since 2018. VS Code terminal lead Daniel Imms (Tyriar) wrote: *"We have no plans on restoring sessions like this as the experiment I built earlier ended up revealing it would be a lot of code/config to get this right. Instead we're opting for extensions like Terminals Manager to take up this role."*
- Issue #128001 ("Workspace-Specific Persistent/Saved Terminals") is labeled `extension-candidate`: *"whenever I close and reopen vscode, or try and load the workspace from scratch, these terminals disappear."*
- Issue #123518: remote terminal processes only stick around for 60 seconds after a disconnect.
- The Terminals Manager extension (fabiospampinato.vscode-terminals) has only 71,699 installs despite being officially recommended by the VS Code team — clear sign demand outstrips supply.
- Workarounds shared widely: wrap the integrated terminal in tmux/screen via a custom profile (George Honeywood blog; João Moreno's "Persistent terminal sessions in VS Code" on Medium).

**2. Copy/paste is broken or unintuitive.**
- Issue #19348 ("Allow users to do copy paste in the integrated terminal using ctrl+c, ctrl+v") remains a years-long usability complaint; IntelliJ-style selection-sensitive copy is the explicit ask.
- Issue #238802 ("Can't select and copy and paste text from Terminal view"): *"Sometimes I end up crying and break it up while yelling, 'Noooooo!' into the air."*
- Issue #112557: Editor's Ctrl+V sometimes pastes into the integrated terminal due to focus bugs.
- Issue #283056 ("Remove ugly throttling mechanism when pasting to the terminal"): Jarred Sumner (Bun creator) drove a viral X post in Dec 2025 — *"Why is pasting into VSCode Terminal slow? Because it sleeps for 5ms every 50 characters."* Tyriar conceded: *"It sucks though so we should fix it."* Fix is `insiders-released` in 2026.
- Arch Linux Forums (Feb 2025): *"This has been broken at least a week. … Vscode is useless right now. … BTW, side rant, this is the last straw. I will be switching to Neovim."*

**3. Remote-SSH terminal performance and disconnects.**
- Issue #191066: *"when connected via SSH with the terminal integrated in VSC, the connection is incredibly slow and completely unusable. everything done via VSC takes ages, even saving a file."*
- Issue #213304: terminal output during large builds (e.g. building curl) lags so badly that VS Code itself can hang and lose the SSH connection; piping through `vscode -` avoids it.
- vscode-remote-release #8444: *"Takes between 30s to 60s before I can view any folders/files or open a terminal on the remote. … I really don't think it is a network issue since all my other connections to this machine work perfectly, it is only VSCode Remote SSH that is slow."*
- vscode-remote-release #10869: `screen -v` takes ~11 seconds inside Remote-SSH terminal due to a `poll(POLLNVAL)` loop hitting >1M syscalls.
- The Remote-SSH extension (ms-vscode-remote.remote-ssh) has 33,967,307 installs on the VS Code Marketplace — meaning these complaints affect tens of millions of developers.
- Earl C. Ruby III blog: *"I really like VSCode, and I use the ssh plugin to edit code on remote machines, but recently the ssh connection has been dropping all of the time, even when I'm editing code on another machine that's on the same local network."*

**4. Terminal Suggest (released 2025) is intrusive and breaks experienced workflows.**
- Issue #279538: *"This behavior feels intrusive and breaks a workflow that has been refined for years by experienced developers. Because of this, I had to disable the entire feature. I strongly believe this is a bug rather than an improvement."*
- Issue #283496: *"I'm used to pressing [Tab] to use my shell's autocomplete. … At the end of the day it is still frustrating — and so some users like myself are inclined to simply disable the feature entirely."*
- Stefan Judis blog: *"The terminal is supposed to be a simple and calm place and this feels very stressful, doesn't it?"*

**5. AI/Copilot agents can't read remote SSH terminal output, blocking agentic workflows.**
- Issue #270207: *"AI agents (GitHub Copilot, etc.) cannot automatically read SSH terminal output in VS Code without getting stuck waiting for responses, making remote development workflows inefficient. … Manual intervention required to continue workflow, can't do nothing else than stop and close the terminal."*
- Issue #287694: users want to auto-approve all terminal commands for an entire agent session up-front rather than per-command — currently the first command must be approved before the global option appears.

**6. No vertical split / no detachable terminal window.**
- Issues #254638, #160501, #252458: users repeatedly request flexible splits (horizontal + vertical) like Terminator and iTerm2.
- The VS Code Roadmap wiki explicitly lists *"detaching terminals"* as the **second most upvoted feature request**, blocked by workbench architecture: *"Support for detachable workbench parts is our most upvoted feature request which due to architectural issues is challenging to implement."*
- Issue #252647: terminal tabs can only be placed left or right, *"which eats up screen width, especially when working with copilot agent on the side."*

**7. Terminal output rendering performance.**
- Issue #213304 (above) — heavy build output triggers the `lineFeed @ InputHandler.ts:709:10` hot path.
- Issue #292572 ("Terminal perf fixes", Feb 2026) is the VS Code team's own catch-all for ongoing perf debt.

### 2. Most-Requested Features (synthesized, ranked)

| Rank | Feature | Evidence |
|---|---|---|
| 1 | Session restore (process + buffer + layout) across full restarts and SSH reconnects | Issues #44302, #128001, #131634, #123518; Terminals Manager + Restore Terminals are the third-party stopgaps |
| 2 | Detachable terminal windows / true multi-window terminal | #2 most-upvoted on VS Code Roadmap wiki |
| 3 | Vertical + horizontal flexible split, tmux-style pane juggling | Issues #160501, #254638, #252458 |
| 4 | Better terminal output management — collapsible command "blocks," jump-to-prompt, search-across-history, save-buffer-as-file | Save Terminal Buffer extension (aosho235); inspired by Warp blocks |
| 5 | Tab autocomplete that defers to the shell, with optional opt-in AI overlay | Issues #210277, #279538, #283496 |
| 6 | Sane Ctrl+C / Ctrl+V copy-paste with selection-aware behavior | Issues #19348, #238802, #112557 |
| 7 | Faster, non-throttled paste | Issue #283056 (now landing) |
| 8 | AI agent that reads remote SSH terminal output reliably | Issue #270207 |
| 9 | Per-workspace auto-launch profiles with command pre-seeding ("startup tasks for terminals") | Terminals Manager + Tabulous + Command Runner extensions |
| 10 | Native sshd-style connection manager UI with saved profiles, jump hosts, port forwards | Tabby standalone provides this; VS Code only has SSH config file editing |

### 3. AI Terminal Features in Demand

GitHub Copilot's `@terminal` participant and `terminal.inlineChat` are now baseline. Documented capabilities:
- GitHub Docs: *"Use the @terminal chat participant to ask specific questions about the command line. For example: @terminal find the largest file in the src directory · @terminal #terminalLastCommand to explain the last command and any errors."*
- VS Code Docs: *"Start an inline chat directly in the terminal to get help with shell commands… When Copilot provides a response, you can select Run to execute the command directly or Insert to add it to the terminal for further editing."*

What users want beyond this baseline:
- **Explain-last-command and explain-error-output** as a one-keystroke action (already partly done via `#terminalLastCommand`, but discoverability is poor).
- **Natural-language → command** with safety preview, Warp-style. Quote (Kedasha Kerr, GitHub Blog): *"With GitHub Copilot in your IDE, you can now get help with error messages right in the terminal. Just highlight the error message, right click, and select 'Explain with Copilot.'"*
- **Agentic terminal that can read output reliably**, including over SSH — Issue #270207 is the canonical blocker.
- **Session-wide auto-approve** for trusted command sets (Issue #287694).
- **MCP / Tabby VSCode Agent pattern**: SteffMet's `tabby-vscode-agent` runs an MCP server inside Tabby, exposing terminal control to Copilot/Cursor/Windsurf with a Pair Programming Mode that requires confirmation before each destructive command. This pattern (MCP server bridging shell ↔ AI client) is becoming a de-facto standard.
- **Local LLM completion** (privacy-first). Examples: llama.vscode (local), Tabnine, Cerebras-backed `fsiovn/ai-autocomplete`. Demand is driven by Copilot's token limits and corporate restrictions.

### 4. Comparison with External Tools — What Users Want Imported

**From Warp:**
- Command **blocks** (each command + its output as a navigable, collapsible unit) — Hacker News (Show HN: Warp): *"the terminal's teletype-like interface has made it hard for the CLI to thrive. After 20 years of programming, I still find it hard to copy a command's output."*
- AI agent in the same scroll stream as shell commands.
- IDE-style text editing in the prompt (multi-cursor, selection).
- A "vscode integrated terminal?" request was opened against Warp itself (warpdotdev/Warp #3560) — bidirectional demand.

**From iTerm2 / Tabby / Terminator:**
- Flexible split panes, broadcast input to multiple panes.
- Saved SSH profiles with a connection manager UI. LogRocket comparison: *"Tabby has built-in support for SSH connections, allowing users to easily connect to a remote server by using a public key, password, or agent-forwarding authentication method. To provide SSH functionality, VS Code uses extensions."*
- Image (Sixel/iTerm protocol) support — already in VS Code under `terminal.integrated.enableImages` but disabled by default and buggy on Windows.

**From Fish / Zsh plugins:**
- History-based autosuggest (the dim suggestion you accept with right-arrow).
- Per-directory history.
- Rich tab completion that knows about the active CLI (git, npm, docker).

### 5. Gaps / Opportunities for a New Extension

1. **Bulletproof session restore.** No extension fully solves cross-restart, cross-SSH-reconnect, layout-preserving session restore with running-process reattach. Terminals Manager (71,699 installs) and Restore Terminals only cover slices. A tmux-on-rails extension that transparently wraps every terminal in a workspace-scoped tmux/screen session, with a UI for reattach/detach and zero-config remote support, would address the highest-engagement open issue cluster.

2. **Warp-style command blocks inside VSCode.** Ghostty Terminal (tobilg.ghostty-terminal — *"Terminal powered by ghostty-web (WASM) instead of xterm.js"*) and the various MCP bridges suggest the technical path: replace or wrap xterm.js with a block-aware renderer that uses VS Code's existing shell-integration OSC 633 sequences for command boundaries. The OSC 633 protocol is already documented and stable.

3. **Better SSH terminal pipeline.** A user-space fix for poll(POLLNVAL) storms (Issue #10869), output throttling tuned for high-bandwidth remote stdout, and a "buffered remote" mode that streams output via a side channel rather than the SSH-tunneled pty.

4. **Per-shell, shell-native autocomplete that doesn't fight the shell.** Embrace fish_autosuggestion-style history hints and let `Tab` go straight to the shell; offer AI suggestions as separate ghost text bound to a distinct keybinding (e.g. `Alt+Tab`). The negative feedback on Microsoft's Suggest feature (#279538, #283496) maps directly to this design choice.

5. **AI agent over SSH.** Issue #270207 is wide open — an extension that proxies the agent's terminal calls through a remote-side helper (similar to how VS Code Server tunnels the LSP) and reliably surfaces stdout/stderr to the agent would be highly valuable, especially for DevOps and infra teams.

6. **Saved-command launcher with team sharing.** Command Runner (knb47/vscode-command-runner) and Shell Command 2 already prove demand, but neither offers team sync, parameterized templates, or audit logging. Combined with Copilot, a "natural-language → parameterized saved command" library is unfilled white space.

7. **Embedded modern terminal renderer.** Ghostty's WASM build, and Warp's open question of "is it possible to integrate via TypeScript and WebAssembly," suggest a real opening for a GPU-accelerated terminal renderer extension that supersedes xterm.js inside the VS Code panel.

### 6. Direct Quotes (curated)

- *"This behavior feels intrusive and breaks a workflow that has been refined for years by experienced developers. … I strongly believe this is a bug rather than an improvement."* — GitHub user, vscode #279538
- *"Why is pasting into VSCode Terminal slow? Because it sleeps for 5ms every 50 characters."* — Jarred Sumner (Bun), X, Dec 2025
- *"Sometimes I end up crying and break it up while yelling, 'Noooooo!' into the air."* — GitHub user, vscode #238802
- *"AI agents (GitHub Copilot, etc.) cannot automatically read SSH terminal output in VS Code without getting stuck waiting for responses, making remote development workflows inefficient."* — GitHub user, vscode #270207
- *"We have no plans on restoring sessions like this. … Instead we're opting for extensions like Terminals Manager to take up this role."* — Daniel Imms (VS Code terminal lead), vscode #44302
- *"i'm just wondering if it's possible to use warp as the integrated terminal in vscode somehow … what would be way better is to actually just use warp inside vscode itself."* — warpdotdev/Warp #3560
- *"Support for detachable workbench parts is our most upvoted feature request which due to architectural issues is challenging to implement."* — VS Code Roadmap wiki

## Details — Source Map by Category

- **microsoft/vscode repo (primary signal of demand):** #44302, #128001, #131634, #123518, #210277, #279538, #283496, #287694, #270207, #252647, #252458, #254638, #160501, #19348, #238802, #112557, #283056, #213304, #185413, #214420, #311849, #292572, #143.
- **microsoft/vscode-remote-release:** #8444, #10869, #1257, #9219, #4379.
- **VS Code Marketplace (verified install counts, May 24, 2026):** ms-vscode-remote.remote-ssh (33,967,307 installs), formulahendry.terminal (1,813,654 installs; the author's own note: *"From v0.0.4, this extension will have limited updates for bug fix or feature development, because: … VS Code already has basic built-in support for the terminal from v1.2"*), fabiospampinato.vscode-terminals (71,699 installs), bwildeman.tabulous (11,194 installs), Tyriar.terminal-tabs (deprecated, replaced by built-in tabs), aosho235.vscode-save-terminal-buffer, EthanSK.restore-terminals, tobilg.ghostty-terminal, Orta.cc-terminal.
- **Competitor analysis:** Warp docs ("Migrate to Warp from VS Code terminal"), Warp blog ("How to Open Warp from VS Code"), warpdotdev/Warp #3560, LogRocket "How Tabby compares with the VS Code terminal," SteffMet/tabby-vscode-agent (MCP-server pattern), w3tutorials "How to Set Up Warp Terminal as VS Code's Integrated Terminal."
- **AI features:** GitHub Docs (Copilot Chat participants), VS Code Docs (Terminal Basics, Shell Integration OSC 633), Stefan Judis blog, Kedasha Kerr / GitHub Blog ("10 unexpected ways to use GitHub Copilot"), Brian Douglas / GitHub Blog, Anil Goyal Medium, Augment Code "12 Must-Have VS Code Extensions," The New Stack "5 AI Extensions to Help Improve Your VS Code Experience," Visual Studio Magazine "Top 10 AI Extensions for Visual Studio Code."
- **Workflow / blog posts:** João Moreno (Medium, "Persistent terminal sessions in VS Code"), George Honeywood (tmux + VS Code), Earl C. Ruby III (SSH disconnects), CodeWithSusan (Remote-SSH connection issues), Leonardo Montini ("Most Upvoted VS Code Feature"), AI Bud (SSH/WSL slowness troubleshooting).
- **External social:** Arch Linux Forums (Feb 2025 paste-broken thread), Hacker News "Show HN: Warp," Jarred Sumner on X.

## Recommendations

**Stage 1 — Ship in the first 4 weeks (low risk, high signal).**
1. **Session-restore-first MVP** that wraps every terminal in a workspace-keyed tmux/screen session (or zellij where available), with auto-reattach on window reload, full VS Code restart, and Remote-SSH reconnect. Surface a "Reattach to running 'npm run watch'" command in the palette (this is bpasero's own ask in #44302 — *"my biggest use case is to reconnect to a running 'npm run watch'"*). Benchmark: 5,000 installs in 60 days suggests product-market fit; <500 installs means rethink positioning.
2. **Sane copy/paste defaults.** Selection-sensitive Ctrl+C (copy when selection exists; SIGINT otherwise), Ctrl+V paste without the 5ms-per-50-chars throttle, bracketed paste warnings for multi-line, and a "Copy last command output" command. Issues #19348, #283056, #112557.

**Stage 2 — Differentiation (months 2–4).**
3. **Command blocks UI** on top of VS Code's existing shell integration (OSC 633) — collapsible per-command, jump-to-prev/next-prompt, save-block-to-file, copy-output-without-prompt. This is the single biggest UX delta vs Warp/Wave.
4. **History autosuggest** (fish-style ghost text from per-workspace shell history), bound to right-arrow, that does NOT collide with shell tab-complete. Default-off the noisy Microsoft Suggest popup unless the user opts in.
5. **Remote-SSH output channel improvements**: detect large-output commands (>10MB/s) and stream via a side channel; pre-render output server-side and ship deltas. Mitigates #213304 and #191066.

**Stage 3 — AI moat (months 4–8).**
6. **AI terminal that works over SSH.** Address #270207 directly via a remote-side helper agent that captures stdout/stderr in structured form and forwards to the chat agent. Ship session-wide auto-approve presets (#287694) with risk-rated patterns (read-only vs write vs sudo).
7. **Natural-language saved-command launcher** with team sync and audit log (Command Runner + parameterized Copilot generation).
8. **MCP-server bridge** so external AI clients (Cursor, Windsurf, Claude Desktop) can drive terminals in VSCode the same way SteffMet's tabby-vscode-agent does for Tabby.

**Pricing / positioning benchmarks**
- A paid tier is justified only if AI features or team sync are involved; the persistent-session and copy/paste fixes should be free to drive top-of-funnel.
- Reference pricing of adjacent tools: **GitHub Copilot Pro $10/month** (per GitHub Docs: *"Copilot Pro is billed at $10 USD per calendar month"*; note GitHub announced a June 1, 2026 transition to usage-based billing but the $10 Pro plan price is unchanged); **Tabnine Dev tier $12/user/month** (Enterprise $39, Agentic $59); **Warp Build $20/month** (the legacy Warp Pro plan was retired Dec 1, 2025 — Warp docs: *"Users still on legacy Pro, Turbo, or Lightspeed plans continue to use Overages (Legacy) until their first renewal after December 1, 2025"*; Free tier offers 75–150 credits/mo, Business is $50/user/mo).
- Threshold to escalate: if Microsoft ships full process-revive across restarts (extension of Issue #131634) in a 2026 release, pivot focus immediately to blocks UI + remote AI; those remain unaddressed.

## Caveats

- **Reddit data is thin.** Search indices have heavily de-indexed reddit.com; r/vscode, r/devops, r/programming threads were not directly retrievable. Substituted X/Twitter, Arch Linux forums, GitHub issues, and dev blogs.
- **Quantitative GitHub reaction counts could not be verified individually** because the sort-by-reactions issue search URL is blocked by GitHub's robots.txt and most issue pages now show "Reactions are currently unavailable" to scrapers. The "most upvoted" claims for the VS Code roadmap (detachable parts → terminals) and Multi-Window VS Code are confirmed via the Microsoft Wiki Roadmap page and Leonardo Montini's dev.to article respectively.
- **Marketplace install counts** are spot values for May 24, 2026 and will drift; they are not normalized for active usage.
- **Some sources are forward-looking / speculative**: the "fix" for paste throttling (#283056) was `insiders-released` at the time of writing but had not shipped to stable; the Ghostty WASM and Warp-in-VSCode WebAssembly approaches are *theoretical paths*, not shipped products.
- **AI feature demand is moving fast.** Findings from 2024–early 2026 may already be partly addressed by Copilot in newer VS Code Insiders builds — validate against the latest release notes before locking the roadmap.
- **Pricing tiers shift frequently**; GitHub Copilot is moving to usage-based billing on June 1, 2026, and Warp's tier structure was overhauled Dec 1, 2025. Re-verify before publishing any go-to-market collateral.