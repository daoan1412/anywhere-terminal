# AI Feature Research — Warp & cmux source-code audit (for AnyWhere Terminal)

> **Status:** Source-grounded research (2026-05-28). Supersedes the issue-tracker-level speculation in `docs/PLAN.md` §10 (AI Bridge) with concrete, line-referenced findings from reading the actual code of two AI-native terminals.
>
> **Method:** Four parallel explorer agents read the source of `warp` (Rust, 66 crates) and `cmux` (Swift + Next.js). Portability was then cross-checked against AnyWhere Terminal's real code (`src/pty/oscParser.ts`, `src/pty/processCwd.ts`, `package.json`).
>
> **Sources audited:**
> - Warp: `/Users/huybuidac/Projects/ai-oss/warp` — *"an agentic development environment, born out of the terminal. Use Warp's built-in coding agent, or bring your own CLI agent (Claude Code, Codex, Gemini CLI…)."*
> - cmux: `/Users/huybuidac/Projects/ai-oss/cmux` — *"A Ghostty-based macOS terminal with vertical tabs and notifications for AI coding agents."* (its "Vault" = AI CLI session orchestrator)
> - Reference: `/Users/huybuidac/Projects/ai-oss/vscode`, `/Users/huybuidac/Projects/ai-oss/xterm.js`

---

## 0. Tóm tắt (Vietnamese TL;DR)

**Câu kết luận một dòng:** Cả Warp và cmux đều dùng **PTY + escape sequence (OSC) làm "bus tích hợp AI"** — và AnyWhere Terminal (AT) **đã ngồi sẵn trên đúng cái bus đó**. Đây là lợi thế lớn nhất của AT.

Hai nhóm tính năng AI khác nhau về độ khả thi:

1. **Orchestrate AI CLI agent (Claude Code, Codex, Gemini, OpenCode…)** — đây là phần **dễ port nhất và giá trị nhất** cho AT. cmux gọi đây là **"Vault"**. Nó gồm: phát hiện pane nào đang chạy agent nào, hiện trạng thái (đang chạy / chờ bạn duyệt / xong), **thông báo khi agent cần bạn** (notification ring), và **restore/resume/fork** session agent bằng cách đọc file lịch sử riêng của từng agent (`~/.claude/projects/**/*.jsonl`, SQLite `~/.codex/state_5.sqlite`…). **AT không cần model API key, không cần `vscode.lm`** cho nhóm này — chỉ cần đọc OSC + scan process + đọc file. AT đã có sẵn cả ba.

2. **Trợ lý lệnh AI trong terminal** (NL→command, autosuggest, sửa lệnh sai) — Warp làm rất tốt. Phần **input classifier** (tự đoán bạn đang gõ lệnh shell hay câu hỏi tiếng Anh) có một bản **heuristic thuần (không ML)** port sang TypeScript được ngay. Phần sinh lệnh thì thay server riêng của Warp bằng `vscode.lm`.

**Thứ tự nên làm (chi tiết ở §6):** (1) surface OSC 633 lifecycle đã parse sẵn → (2) phát hiện agent + notification "cần chú ý" → (3) Vault: restore/resume agent session → (4) MCP client bridge → (5) input classifier heuristic → (6) NL→command qua `vscode.lm`.

**Để catch-up nhanh:** §7 là bảng ưu tiên 2 trục (độ hấp dẫn × độ khó) cho TẤT CẢ idea AI — xem trước nếu chỉ có 2 phút.

**Không nên copy:** `computer_use` (điều khiển chuột/màn hình OS — VS Code không có API), built-in agent loop full của Warp (chạy trên server riêng), local LLM bundling.

---

## 1. The one strategic insight

Both products converge on the same architecture, stated explicitly by the Warp-agent researcher:

> *"The PTY is the universal integration bus. Both interactive BYO-agents (OSC 777/9 in, prompt text out) and the built-in agent's `run_shell_command` flow through the terminal model. This is the highest-leverage insight: a terminal extension is already sitting on the exact channel Warp uses."*

cmux says the same from the other side: its entire "agent needs attention" loop is **terminal escape sequences**, not stdout-scraping or process polling.

**What this means for AT — verified against AT's own code:**

| AT already has | File | Implication |
|---|---|---|
| A passive host-side OSC parser that handles OSC 7 + OSC 633 **A/B/C/D/E** | `src/pty/oscParser.ts:3-4` | The integration bus is already wired. |
| It **already emits `commandEnd` with exit code** | `src/pty/oscParser.ts:231,239` | Command lifecycle + exit codes exist host-side today — just not surfaced to the webview. This is the single missing wire for half the cmux/Warp features. |
| Other OSC numbers are recognized but ignored (0, 8, 52, 1337…) | `src/pty/oscParser.ts:176` | Adding OSC **9 / 777** (the agent-notification sequences) is a few lines in an existing dispatch. |
| Per-PID cwd via `lsof`/`/proc` shell-out | `src/pty/processCwd.ts` | Process-table access already exists; extending to read **argv** (for agent detection) is a small step. |
| xterm.js v6 + `@xterm/addon-serialize` | `package.json:564,568` | Buffer/transcript serialization available for restore + transcript panels. |
| `engines.vscode ^1.105.0` | `package.json:33` | `vscode.lm` (Language Model API) + native MCP API both available. |

> Net: **AT is ~70% pre-wired for the cmux "Vault" feature set and the Warp block-context feature set.** The expensive parts (custom GPU renderer, server-side agent brain, OS automation) are exactly the parts you should *not* copy.

---

## 2. Feature catalog — Theme A: AI CLI agent orchestration (the "Vault")

**This is the headline reusable cluster. Both terminals do it; cmux does it most thoroughly.** None of this needs an AI model on AT's side — AT becomes the *orchestrator* of the user's existing CLI agents.

### A1 — Detect which pane is running which AI agent
- **Warp:** command-prefix detection on the typed command, resolving env-assignments + aliases. Enum of 13 agents (Claude, Gemini, Codex, Amp, Droid, OpenCode, Copilot, Pi, Auggie, CursorCli, Goose, Hermes, Vibe). `app/src/terminal/cli_agent.rs:132-169, 345-380`.
- **cmux:** process-table scan reading each process's **argv + environment**, matched against detect rules (`processName` basename + `argvContains` needles). `Sources/VaultAgentProcessScanner.swift:61-138, 767-796`. Critically, it only counts processes carrying cmux's own launch tags (`cmuxWorkspaceID`/`cmuxSurfaceID` env) so it can map a PID back to a specific pane.
- **AT portability: Medium.** AT already shells the process table (`processCwd.ts`) and parses typed commands via OSC 633 `B` (command start). Two viable paths: (a) prefix-detect on the OSC 633 command line (Warp's way — simplest), or (b) tag the PTY env at launch + scan argv (cmux's way — robust to `&&` chains, subshells). **Obstacle:** mapping PID↔terminal needs the env-tag trick; AT controls PTY spawn so this is easy to add.

### A2 — Agent lifecycle status (running / blocked-on-permission / done)
- **Warp:** agents emit **OSC 777** with sentinel title `warp://cli-agent` and a JSON body; a versioned parser maps `event` strings → `SessionStart / PromptSubmit / ToolComplete / Stop / PermissionRequest / QuestionAsked / IdlePrompt`, driving an `InProgress / Success / Blocked{message}` state machine. The JSON comes from a **Warp plugin auto-installed into the CLI** (`claude plugin install warpdotdev/claude-code-warp`). Codex has no plugin → plain **OSC 9** notifications coerced to `Stop`. `app/src/terminal/cli_agent_sessions/{event,listener}/…`, `plugin_manager/claude.rs:73-83`.
- **cmux:** identical signal family — **OSC 9 / 99 / 777** desktop-notification escapes, plus injected agent **hooks** (Claude Code `Stop`/`Notification` hooks, RovoDev `eventHooks:` YAML, Hermes `hooks:`) that report lifecycle (`unknown/running/idle/needsInput`). `Sources/GhosttyTerminalView.swift:4540`.
- **AT portability: Medium.** Add OSC 9/777 handlers next to the existing OSC dispatch (`oscParser.ts:176`). Coarse status (Stop via OSC 9) is **Easy** and works for *any* agent today. Rich status (blocked-on-permission) needs per-agent plugins/hooks — that's the real cost, and it's incremental (ship coarse first).

### A3 — "Agent needs your attention" notification (the blue ring)  ⭐ highest ROI
- **cmux:** the signature feature. Pipeline: `OSC 9/99/777/BEL → notification store → focus gate → effects (record / desktop / sound / paneFlash) → blue ring overlay + sidebar unread badge + macOS notification`. Key behaviors:
  - **Focus-gated:** desktop notification + sound suppressed only when *that exact pane* is focused AND the window is key; the in-app unread indicator still records. `Sources/TerminalNotificationStore.swift:1474-1482, 616-628`.
  - **Dedup/throttle:** one notification per (tab, surface) — newer replaces older (`:1434-1438`); optional cooldown key/interval (`:1178-1194`); a coalescing queue collapses bursts (`TerminalNotificationQueue.swift:122-150`).
  - **User-scriptable policy:** per-repo `.cmux` config can run a hook subprocess to rewrite/veto each notification's effects (`TerminalNotificationPolicy.swift:21-52, 228-313`).
- **AT portability: Easy** (detection + delivery) / **Medium** (the literal ring). VS Code gives `window.state.focused` + `onDidChangeWindowState` for the focus gate, `window.showInformationMessage` for delivery, and a status-bar item for the unread badge. The per-pane "blue ring" has no VS Code chrome API, but **AT owns its xterm.js webview DOM** so it can draw its own accent border around the affected terminal; degrade to a status-bar badge + "jump to waiting terminal" command otherwise. **Obstacle:** users must wire their agent hooks to emit OSC 9 / run a notify command — same requirement cmux has (it ships a `cmux notify` CLI for this; AT would ship an equivalent or a Claude-Code hook snippet).

### A4 — Cross-agent searchable session index + resume  ⭐ the "Vault" core
- **cmux:** a unified, searchable list of *every* past agent session across *every* agent, each resumable in one click. It reads each agent's **own on-disk history**:
  - per-agent loaders parse JSONL (ripgrep over `~/.claude/projects/**/*.jsonl`) or SQLite (`~/.codex/state_5.sqlite`, `~/.local/share/opencode/opencode.db`, `~/.hermes/state.db`) or per-session JSON (`~/.rovodev/sessions/<id>/metadata.json`).
  - resume is done by **synthesizing the agent's native CLI command**: `claude --resume <id>`, `codex resume <id>`, `acli rovodev run --restore <id>`, `opencode --session <id>`, etc., **re-injecting per-session flags** captured at index time (model, permission-mode, sandbox, reasoning effort) so the resumed session keeps its settings.
  - **SQLite safety pattern worth stealing:** copy the DB + `-wal`/`-shm` sidecars to a temp dir and open read-only, to avoid lock contention with the live agent. `Sources/SessionIndexStore+CodexSQL.swift:36-47`.
  - **Auth preservation:** Claude resume re-exports a whitelist of `ANTHROPIC_*` / `CLAUDE_CONFIG_DIR` env so resumed sessions hit the right account. `Sources/RestorableAgentSession.swift:277-286`.
- **AT portability: Easy–Medium** — *the most portable high-value feature.* Pure file/SQLite reads + spawning a resume command in a fresh PTY. Node has `better-sqlite3` and can shell to `rg`. **Obstacle:** you must encode each agent's path layout + parse logic (this is where the bulk of cmux's effort lives — see the table in §9). Ship Claude + Codex first (covers most users).

### A5 — Fork conversation
- **cmux:** branch an agent conversation into a new pane/split/workspace from the same point, via native fork flags: `claude --resume <id> --fork-session`, `codex fork <id>`, `opencode --session <id> --fork` (version-gated ≥1.14.50, probed via `opencode --version`). `Sources/RestorableAgentSession.swift:591-648`, `Sources/AgentForkSupport.swift:50,292-351`.
- **AT portability: Easy** where the agent supports it (just a different CLI flag) — entirely dependent on each agent's native fork capability; cmux invents nothing here.

### A6 — Agent transcript preview in a side panel
- **cmux:** browse a past session and preview the conversation (user/assistant/tool turns) in the right sidebar. `RovoDevTranscriptPreview.load` JSON-parses and normalizes many schemas — roles from `role/kind/speaker/sender/author/type`, content from `content/text/parts/blocks/output/result`, tool calls rendered with name + pretty-printed JSON args. `Sources/RovoDevTranscriptPreview.swift:34,111-140,258-277`; other agents stream JSONL line-by-line.
- **AT portability: Medium–Hard.** The parser ports directly to TS and a webview transcript panel is easy. **Obstacle:** depends on knowing each agent's session-file path + schema (undocumented, version-fragile). **Cheaper live alternative for AT:** capture the agent's stdout directly from node-pty (AT owns the PTY) instead of scraping files — AT has an advantage cmux lacks here.

### A7 — Hibernate idle agents
- **cmux:** snapshot a *running* agent pane and let it sleep when idle; only `idle` lifecycle is hibernatable (reported by the agent's hook). `Sources/AgentHibernation/AgentHibernationLifecycleState.swift:15-17`.
- **AT portability: Hard-ish** — needs reliable idle/needs-input lifecycle (agent hook cooperation). Lower priority; revisit after A2/A4.

### A8 — Prompt injection / rich composer into the agent's PTY
- **Warp:** an IDE-style multi-line composer that injects prompts straight into the agent's PTY, including batched code-review prompts. `app/src/terminal/cli_agent.rs:408-466`.
- **AT portability: Easy** — `node-pty` write is trivial; AT could offer a "compose prompt" box that writes to the focused agent pane. Nice differentiator with low cost.

### A9 — Data-driven agent registry (the cleanest abstraction)
- **cmux:** agents are **JSON/config records**, not code: `{id, detect rule, sessionIdSource, resumeCommand template ({{sessionId}}/{{sessionPath}}/{{executable}}), cwd policy, sessionDirectory}`, mergeable per-project. Adding an agent needs **no code**. `Sources/VaultAgentRegistry.swift:12-20, 311+`. The key abstraction is `sessionIdSource`: `.argvOption("--x")` | `.piSessionFile` (newest jsonl in dir) | `.grokSessionDirectory`.
- **AT portability: Easy and recommended as the foundation** — define AT's agent support as a JSON registry from day one so the community can add agents via PR/config instead of code.

---

## 3. Feature catalog — Theme B: in-terminal AI command assistance (Warp)

This is Warp's classic "AI in the command line" surface. Needs a model (→ `vscode.lm`) except where noted.

### B1 — Input classifier: NL-vs-shell auto-detection  ⭐ portable gem
- **What:** as you type, the input silently flips between "Shell" and "AI" mode. `git push` stays shell; `how do I undo my last commit` flips to AI.
- **How:** two impls behind one `InputClassifier` trait (`crates/input_classifier/src/lib.rs:52`). (a) a tiny **`bert_tiny` ONNX** model (candle/ort backend) → softmax 2 logits `[p_ai, p_shell]` (`onnx/mod.rs:93-198`); (b) a **pure heuristic** (no ML): counts natural-language words against embedded dictionaries (English + StackOverflow + command list), stems them, subtracts shell-syntax tokens, compares NL ratio to tuned thresholds (`heuristic_classifier/mod.rs:42-158`, `natural_language_detection/src/lib.rs:36-81`). Allowlists force `claude/codex/gemini` → shell so it never hijacks those CLIs (`util.rs:14-29`). Runtime adds a history fuzzy-match short-circuit and an "is this a follow-up to an AI block (yes/continue/approve)" signal.
- **AT portability: Easy** (heuristic) / **Medium** (ONNX). The heuristic version reimplements in TypeScript directly (word lists + a token tagger). The ONNX model + tokenizer are tiny and present (`crates/input_classifier/models/onnx/`) and run in a webview via `transformers.js`/`onnxruntime-web`. **Obstacle:** best quality wants a command-spec engine (B7) for the `token_description` signal; without it, the dictionary path still works.

### B2 — Natural-language → command generation
- **What:** AI-mode input produces a runnable command (with safety preview).
- **How:** routes to Warp's agent / server endpoints; the *command-level* relevance is that B1 decides when to route. Warp's actual prompt/model lives server-side (Go, not in repo).
- **AT portability: Medium** — replace Warp's server with `vscode.lm.selectChatModels()`; AT supplies the prompt + block context. **Honest caveat from PLAN.md §10:** ship explanation-only first; NL→command is easy to misfire into destructive commands — gate behind a preview+confirm.

### B3 — Next-command autosuggestion (+ history-only fallback)
- **What:** ghost-text suggestion of the *next whole command*, cyclable.
- **How:** POSTs block context (`command + truncated output + {pwd, git_branch, exit_code}`) + merged history to Warp's `/ai/generate_input_suggestions` (`app/src/ai/predict/next_command_model.rs`, `block_context.rs:12-59`). A **history-only path** gives offline/instant suggestions with no LLM.
- **AT portability: Medium.** AT already has every input field (OSC 633 → command/exit/cwd). The history-only path is **Easy** and a great MVP; the LLM path swaps Warp's server for `vscode.lm`.

### B4 — Autosuggestion validation (anti-hallucination)
- **What:** silently suppress AI-suggested commands whose flags/args don't actually parse.
- **How:** before display, parse the command and validate each arg against the static completer with a 150 ms timeout (`next_command_model.rs:692-756`).
- **AT portability: Hard** — requires the completion-spec engine (B7). Without it, only shallow validation (does the binary exist on PATH).

### B5 — Command correction ("did you mean?")
- **What:** after a failed command, offer a corrected command.
- **How:** **rule-based** (`thefuck`-style external `command-corrections` crate), *not* an LLM — deterministic rules (history, git-branch) keyed on last command + exit code + cwd. `app/src/terminal/view.rs:14604-14728`.
- **AT portability: Easy.** Reimplement common rules in TS, *or* call `vscode.lm` with the failed command + stderr. AT has command + exit code via OSC 633.

### B6 — AI query suggestions / zero-state prompts
- **What:** suggested NL prompts after a command, and starter prompts in an empty input.
- **How:** `/ai/generate_am_query_suggestions` with just `context_messages + system_context + exit_code` (`app/src/ai/predict/generate_am_query_suggestions/`).
- **AT portability: Medium** — same `vscode.lm` swap; inputs already present.

### B7 — Static completion-spec engine (substrate, not AI)
- **What:** Fig/Carapace-style rich autocomplete. **Not AI**, but it's the substrate B1/B4 lean on.
- **How:** `crates/warp_completer/` + `crates/command-signatures-v2/` (builds TypeScript signature files via yarn at compile time and embeds them).
- **AT portability: Hard** — large self-contained engine with a JS build step. Either vendor a JS spec library (e.g. Fig `autocomplete-specs`) or skip (degrades B1/B4 quality, not function).

---

## 4. Feature catalog — Theme C: agent tooling & loop (Warp)

### C1 — MCP client bridge  ⭐ most portable agent feature
- **What:** connect to user-configured MCP servers (stdio CLI or SSE/HTTP) and expose their tools to the agent.
- **How:** Warp is an MCP **client only**, via the official `rmcp` Rust SDK. Servers configured permissively from Claude-Desktop / VS Code / Warp JSON shapes (`/mcpServers`, `/servers`, `/mcp/servers`), launched as `TokioChildProcess` (stdio) or SSE. Secrets are `#[serde(skip_serializing)]` so they never leave the machine. Config files watched: `~/.warp/.mcp.json`, `~/.claude.json`, `.mcp.json`, `.codex/config.toml`. `app/src/ai/mcp/mod.rs:118-158, 346-434, 617-634`.
- **AT portability: Easy** — Node spawns stdio servers natively; the TS MCP SDK mirrors `rmcp`; **VS Code ships a native MCP registration API** + `vscode.lm` tool-calling. (Note: the `.mcp.json` at Warp's repo root is just GitHub MCP for Warp's own devs, not a product artifact.)

### C2 — Built-in agent loop + tool set
- **What:** Warp's own agent reads code, edits files, runs shell commands, calls MCP tools, orchestrates sub-agents.
- **How:** **server-orchestrated** — the client streams a request and consumes `ResponseEvent` tool-call events; the brain (planner/LLM) is a proprietary Warp cloud service. Client-side tools: `run_shell_command, read_files, apply_file_diffs, grep, file_glob, search_codebase, call_mcp_tool, use_computer, ask_user_question, run_agents, subagent…` (`app/src/ai/agent/task/helper.rs:106-142`). Shell commands run through the **real PTY** (`agent_sdk/driver/terminal.rs:415-468`). Also runs external CLIs headless: `claude --session-id <uuid> --dangerously-skip-permissions --append-system-prompt-file … --mcp-config … < promptfile` (`agent_sdk/driver/harness/claude_code.rs:204`).
- **AT portability: Hard as-is** (the brain is a server). But the *pattern* ports: a local loop with `vscode.lm` for the model + re-implemented tool executors (`run_shell_command` via node-pty, FS via VS Code API). `vscode.lm` already supports tool-calling. This is a big project — not an early target.

### C3 — Agent permissions / auto-approve policy
- **What:** read-only commands auto-run; destructive/network commands always prompt.
- **How:** permission enums (`AgentDecides/AlwaysAllow/AlwaysAsk`) + regex predicates. Default **allowlist** = read-only (`cat, echo, find, grep, ls, which`); default **denylist** = destructive/network (`bash, sh, zsh, curl, wget, eval, exec, source, ssh, scp, rsync, rm, dig…`). `app/src/settings/ai.rs:597-625`, `execution_profiles/mod.rs:31-219`.
- **AT portability: Easy** — pure policy logic; copy the enums + allow/deny lists into TS. Directly satisfies PLAN.md §6.2 "Pair-Programming-Mode per-command confirmation."

### C4 — `computer_use` (GUI control + screenshot)
- **What:** agent drives the desktop GUI (mouse/keyboard/scroll/screenshot), cross-platform.
- **How:** `Actor` trait with mac/win/x11/wayland impls; actions `MouseDown/Up/Move/Wheel, TypeText, KeyDown/Up`; downscaled screenshots. `crates/computer_use/src/lib.rs`.
- **AT portability: Hard — skip.** VS Code/Electron has no native desktop-automation API; would need an N-API addon (`nut.js`/`robotjs`) + OS permissions. Lowest priority.

### C5 — Voice input → command/prompt
- **What:** push-to-talk mic → transcribed text seeding a prompt.
- **How:** `cpal` mic capture → 16 kHz mono → WAV/base64 → **cloud** transcribe (Warp server, Wispr/Whisper). `crates/voice_input/src/lib.rs`, `app/src/ai/voice/transcribe/`.
- **AT portability: Medium** — `MediaRecorder` in the webview is easy; **obstacle:** you must supply your own STT endpoint (Whisper/Deepgram). Niche; defer.

---

## 5. Feature catalog — Theme D: control surfaces

### D1 — `cmux notify` CLI + unix-socket remote command
- **What:** scriptable control from outside the app — `cmux notify` (the recommended way to wire Claude Code `Stop`/`Notification` hooks) and a right-sidebar remote command (`toggle/show/hide/focus/setMode/getState` with `--workspace/--tab/--window` targeting). `Sources/RightSidebarRemoteCommand.swift:12-19`, `Sources/TerminalController.swift:3011`.
- **AT portability: Easy** — map to `commands.registerCommand` so tasks/other extensions can drive AT's panel; VS Code's command palette + a URI handler replace the socket. The notify CLI becomes a tiny bundled binary *or* a documented "emit OSC 9" hook snippet (cheaper).

---

## 6. Recommended adoption order (source-grounded)

Ordered by (value × how-much-AT-already-has ÷ cost). Ties back to `docs/PLAN.md` phases.

| # | Feature | Theme | AT effort | Why this order |
|---|---|---|---|---|
| 1 | **Surface OSC 633 lifecycle (A/B/C/D + exit code) to the webview** | foundation | **XS** | Already parsed & `commandEnd`+exit emitted (`oscParser.ts:231,239`); just forward over IPC. Unlocks A2/A3/B3/B5. This *is* PLAN.md Phase 3.1. |
| 2 | **OSC 9/777 + BEL → "agent needs attention" notification** (focus-gated, deduped) | A2,A3 | **S** | cmux's signature feature; Easy on AT (existing OSC dispatch `oscParser.ts:176` + `onDidChangeWindowState`). Works for any agent at coarse level immediately. |
| 3 | **Agent detection + JSON agent registry** | A1,A9 | **S–M** | Data-driven registry first; prefix-detect on OSC 633 command line. Foundation for everything Vault. |
| 4 | **Vault: cross-agent session index + resume/fork** | A4,A5 | **M** | Highest-value Vault feature; pure file/SQLite reads + PTY spawn. Start Claude + Codex. Steal the WAL-copy SQLite trick + auth-env preservation. |
| 5 | **MCP client bridge** | C1 | **S–M** | VS Code has native MCP API; biggest agent-capability win for least code. PLAN.md §10.2. |
| 6 | **Command auto-approve policy** (allow/deny lists) | C3 | **S** | Pure logic copy; needed before any AT-driven command execution. |
| 7 | **Input classifier (heuristic) + history-only next-command** | B1,B3 | **M** | No model needed; TS reimplementation of Warp's heuristic. Offline, instant. |
| 8 | **NL→command / explain-error via `vscode.lm`** | B2,B5,B6 | **M** | The "AI bridge" of PLAN.md Phase 6.1 — explanation-only first, preview+confirm for generation. |
| 9 | **Prompt composer + transcript panel** | A8,A6 | **M** | Differentiators; A6 can read PTY stdout (AT advantage) instead of file-scraping. |
| — | computer_use, full agent loop, voice, completion-spec engine | C2,C4,C5,B7 | **L/skip** | Defer or skip (see §8). |

> **Items 1–4 are a coherent, shippable "AT = AI-CLI orchestrator" milestone** that needs **zero model integration** and leans almost entirely on infrastructure AT already has. This is the recommended first deliverable and a stronger differentiator than the generic "AI bridge" in the current PLAN.md.

---

## 7. Prioritization matrix — AI ideas by appeal × difficulty

Every AI / AI-coding-agent idea from this audit, scored on two axes so you can pick at a glance. **Appeal** = how much users want it (grounded in the research's pain-frequency + install counts). **Difficulty** = build effort on AT (XS/S/M/L/XL, already discounting what AT has pre-wired per §1). §6 is the *sequence*; this is the *landscape* (includes the skip items with ratings).

> Legend — Appeal: 🔥🔥🔥 High · 🔥🔥 Medium · 🔥 Low.  Difficulty: XS < S < M < L < XL.

### 2×2 quick map

| | Easy–Medium | Hard–Very hard |
|---|---|---|
| **Appeal HIGH** | ⭐ **Do first:** Agent-attention notification (A3) · Vault resume (A4) · History ghost text (B/suggest) · Explain error/selection | **Moonshots:** NL→command (B2) · Built-in agent loop (C2) |
| **Appeal MED–LOW** | **Quick wins / foundations:** Agent detect (A1) · Fork (A5) · Auto-approve policy (C3) · Agent registry JSON (A9) · Prompt composer (A8) · Command correction (B5) | **Skip / later:** computer_use (C4) · voice (C5) · completion-spec engine (B7) · hibernate (A7) · MCP server bridge |

### Theme A — AI coding-agent orchestration (the "Vault") — *biggest differentiator, mostly needs NO model*

| Idea | Appeal | Difficulty | Note |
|---|---|---|---|
| A3 — "Agent needs you" notification (blue ring, focus-gated) | 🔥🔥🔥 | **S** | OSC 9/777+BEL; AT already parses OSC. cmux's headline. **Highest ROI.** |
| A4 — Vault: cross-agent session index + resume | 🔥🔥🔥 | **M** | Read `~/.claude/**/*.jsonl`, SQLite `~/.codex`… → `claude --resume`. Very sticky. Start Claude+Codex. |
| A2 — Agent lifecycle status (running/blocked/done) | 🔥🔥 | S→M | Coarse (Stop via OSC9) = S, any agent; rich (blocked) needs per-agent hooks/plugins. |
| A1 — Detect which pane runs which agent | 🔥🔥 | S–M | Foundation; prefix-detect on OSC 633 B, or env-tag at spawn. |
| A5 — Fork conversation | 🔥🔥 | **S** | Just a CLI flag (`--fork-session`) where the agent supports it. |
| A8 — Prompt composer → inject into agent PTY | 🔥🔥 | **S** | `node-pty` write; a nice prompt-compose box. |
| A6 — Transcript preview in sidebar | 🔥🔥 | M–L | Read each agent's session file (fragile) — OR read PTY stdout (AT advantage). |
| A9 — Data-driven agent registry (JSON) | foundation | **S** | Define agents in config → community adds agents without code. Build as the base. |
| A7 — Hibernate idle agents | 🔥 | L | Needs reliable idle lifecycle. Later. |

### Theme B — in-terminal AI command assistance

| Idea | Appeal | Difficulty | Note |
|---|---|---|---|
| History ghost text (fish-style, no LLM) | 🔥🔥🔥 | **M** | Most-requested UX. Own plan: `docs/PLAN-suggest.md`. No AI needed. |
| Explain error / Explain selection (`vscode.lm`) | 🔥🔥🔥 | S–M | Lowest-risk AI entry (explanation only). PLAN.md §10.1. |
| B5 — Command correction ("did you mean") | 🔥🔥 | **S** | Rule-based (thefuck) or LLM. AT has exit code via OSC 633. |
| B2 — NL→command | 🔥🔥🔥 | M+ | Warp's signature, but **risky** (destructive misfire) → preview+confirm required. |
| B1 — Input classifier (heuristic) | 🔥🔥 (alone 🔥) | M | Just a router; useless until an AI destination exists. Port Warp's heuristic to TS. |
| B3 — Next-command LLM autosuggest | 🔥🔥 | M | Like B2; swap Warp's server for `vscode.lm`. |
| B6 — AI query suggestions / zero-state | 🔥 | M | Nice-to-have. |
| B4 — Validate autosuggestion | 🔥 (invisible) | L | Needs completion-spec engine. |
| B7 — Completion-spec engine (Fig-style, *not* AI) | 🔥🔥 | L | Big engine + JS build. Vendor Fig specs or skip. |

### Theme C / D — agent tooling & control

| Idea | Appeal | Difficulty | Note |
|---|---|---|---|
| C3 — Auto-approve policy (allow/deny lists) | 🔥🔥 | **S** | Needed before AT runs any command. Copy Warp's regex lists. |
| D1 — Notify CLI / commands API | 🔥 (enabler) | **S** | Let tasks/other extensions drive AT's panel. |
| MCP server bridge (expose AT terminals to Claude Desktop/Cursor) | 🔥🔥 | L + security | Real differentiation but large security surface. PLAN.md §10.2. |
| C5 — Voice input | 🔥 | M | Needs own STT endpoint. Niche. |
| C2 — Built-in agent loop (full) | 🔥🔥🔥 | XL | Redundant with Copilot/Cursor; Warp's brain is a server. Skip. |
| C4 — computer_use (GUI control) | 🔥 | XL | No VS Code API. Skip. |

### Two takeaways

1. **The "AT = AI-CLI orchestrator" bundle (A9 → A1 → A3 → A4) is the best deal:** high appeal, medium difficulty, **needs zero model integration**, and is genuinely differentiated vs a generic "AI bridge." Ship it first.
2. **Two low-appeal-but-unlocking foundations:** **A9 (JSON registry)** unlocks all of Theme A, and **surfacing OSC 633 lifecycle to the webview** (PLAN.md Phase 3.1) unlocks A2/A3/B5/history ghost text. Do these even though they're invisible on their own.

---

## 8. Explicitly do NOT copy

| Skip | Why |
|---|---|
| **`computer_use`** (C4) | No VS Code/Electron desktop-automation API; N-API addon + OS-permission friction for niche value. |
| **Warp's full built-in agent loop** (C2) | The planner is a proprietary cloud server; rebuilding it locally is a multi-month project. Use MCP + `vscode.lm` tool-calling instead if/when needed. |
| **Static completion-spec engine** (B7) | Large self-contained engine with a JS compile step; vendor Fig specs or skip. Degrades B1/B4 quality only. |
| **Local LLM bundling** | Bundle bloat; `vscode.lm` already bridges to the user's model (Copilot/Ollama). Matches PLAN.md §11. |
| **Custom GPU/WASM renderer (Warp's, Ghostty)** | AT's xterm.js v6 + WebGL is fine; replacement risks theme/link/serialize integration. Matches PLAN.md §11. |
| **cmux cloud-VM / agent-browser side** | cmux's `web/` (Next.js) runs agents on cloud VMs — wrong shape for a solo OSS extension; out of scope. |

---

## 9. Appendix — Agent session-file locations (the Vault's data map)

The single most reusable artifact from cmux: **where each AI CLI stores its resumable session history.** This is what AT needs to read for Feature A4. (From `Sources/RestorableAgentTypes.swift:3-19`, `SessionIndexModels.swift`, per-agent indexes.)

| Agent | Executable | Session store on disk | Resume command |
|---|---|---|---|
| Claude Code | `claude` | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (also `$CLAUDE_CONFIG_DIR/projects/…`) | `claude --resume <id> [--model] [--permission-mode]` |
| Codex | `codex` | SQLite `~/.codex/state_5.sqlite` (`threads` table); fallback `~/.codex/sessions/**/*.jsonl` | `codex resume <id> [-m][-a][-s][-c effort]` |
| Grok | `grok` | `~/.grok/sessions/**/chat_history.jsonl` (cwd-scoped) | `grok -r <id>` (env `GROK_HOME`) |
| Pi | `pi` | `~/.pi/agent/sessions/*.jsonl` (newest) | `pi --session <id>` |
| OpenCode | `opencode` | SQLite `~/.local/share/opencode/opencode.db` | `opencode --session <id> [-m][--agent]`; fork `--fork` (≥1.14.50) |
| Rovo Dev | `acli` | `~/.rovodev/sessions/<id>/metadata.json` + `session_context.json` | `acli rovodev run --restore <id>` |
| Hermes | `hermes` | SQLite `~/.hermes/state.db` (`sessions` table) | `hermes [--tui] --resume <id> [--model]` (env `HERMES_HOME`) |
| Antigravity | `agy`/`antigravity` | `~/.gemini/antigravity-cli/history.jsonl` | `agy --conversation <id>` |
| Amp | `amp` | (process/hook only — no index) | `amp threads continue <id>` |
| Cursor CLI | `cursor-agent` | (process/hook only) | `cursor-agent --resume <id>` |
| Gemini | `gemini` | (process/hook only) | `gemini --resume <id>` |
| Copilot CLI | `copilot` | (process/hook only) | `copilot --resume <id>` |
| CodeBuddy | `codebuddy` | (process/hook only) | `codebuddy --resume <id>` |
| Factory | `droid` | (process/hook only) | `droid --resume <id>` |
| Qoder | `qodercli` | (process/hook only) | `qodercli --resume <id>` |
| *custom* | from config | config `sessionDirectory` | config `resumeCommand` template |

> "process/hook only" = cmux can detect it *running* (process scan + hooks) but has no historical reader, so it appears only in the live-restore path, not the searchable history. **For AT, ship JSONL/SQLite readers for Claude + Codex + OpenCode first** (covers the majority); the rest degrade to "running now / not running."

**Patterns worth stealing verbatim:**
- **WAL-safe SQLite read:** copy `*.db` + `-wal` + `-shm` to temp, open read-only (`SessionIndexStore+CodexSQL.swift:36-47`).
- **Auth-env preservation on resume:** whitelist + re-export `ANTHROPIC_*`/`CLAUDE_CONFIG_DIR` (`RestorableAgentSession.swift:277-286`).
- **`sessionIdSource` abstraction:** `argvOption("--x")` | newest-file-in-dir | dir-scan — covers every agent's ID-capture style (`VaultAgentRegistry.swift:200`).

---

## 10. Source file index (for verification)

**Warp — command AI:** `crates/input_classifier/src/{lib.rs:52, onnx/mod.rs:93-198, heuristic_classifier/mod.rs:42-158, util.rs:14-124}`, `crates/natural_language_detection/src/lib.rs:36-81`, `app/src/ai/predict/next_command_model.rs`, `app/src/ai/block_context.rs:12-99`, `app/src/terminal/view.rs:14604-14728`.

**Warp — agents/MCP:** `crates/mcp/Cargo.toml:13`, `app/src/ai/mcp/mod.rs:118-434`, `app/src/terminal/cli_agent.rs:132-466`, `app/src/terminal/cli_agent_sessions/`, `plugin_manager/claude.rs:73-83`, `app/src/ai/agent/{api.rs:98-262, task/helper.rs:106-142}`, `agent_sdk/driver/{terminal.rs:415-468, harness/claude_code.rs:204}`, `app/src/settings/ai.rs:597-625`, `crates/{computer_use,voice_input}/src/lib.rs`.

**cmux — Vault:** `Sources/{RestorableAgentTypes.swift:3-19, VaultAgentRegistry.swift, VaultAgentProcessScanner.swift:61-138, SessionIndexStore.swift, SessionIndexStore+CodexSQL.swift:36-47, SessionIndexModels.swift, RestorableAgentSession.swift:277-648, AgentForkSupport.swift, RovoDevIndex.swift, HermesAgentIndex.swift, AgentHibernation/AgentHibernationLifecycleState.swift:15-65}`, `Packages/{CMUXAgentVault,CMUXAgentLaunch}/`.

**cmux — notifications/transcript:** `Sources/{GhosttyTerminalView.swift:4540,4406,11060, TerminalNotificationStore.swift:616-1482, TerminalNotificationPolicy.swift:21-313, TerminalNotificationQueue.swift:122-150, RovoDevTranscriptPreview.swift, SessionTranscriptTypes.swift, RightSidebarRemoteCommand.swift:12-19, TerminalController.swift:3011}`.

**AnyWhere Terminal — readiness:** `src/pty/oscParser.ts:{3-4,176,231,239}`, `src/pty/processCwd.ts`, `src/pty/ShellIntegrationEvents.ts`, `src/webview/terminal/TerminalFactory.ts:416`, `package.json:{33,564,568}`.
