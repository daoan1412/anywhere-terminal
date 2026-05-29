# PLAN — Terminal Suggest (history ghost text + input classifier) for AnyWhere Terminal

> **Status:** Architecture spike (2026-05-28). Source-grounded. Companion to `docs/PLAN.md` Phase 5 (History Autosuggest) and `docs/ai-features-warp-cmux.md` Theme B. This doc exists because PLAN.md Phase 5 says "fish-style ghost text" without addressing the one fact that decides whether it's Easy or Hard: **AT is a passive terminal and does not own the shell's line editor.**
>
> **Scope:** Two features — (1) **history-only next-command** (fish-style ghost text + suggestion dropdown, no LLM), and (2) **input classifier** (decide shell-vs-AI as you type). Plus the rendering/architecture decision they both hinge on.
>
> **Sources read:** local `vscode` (`PromptInputModel`, terminal suggest contrib), local `xterm.js` v6 typings, local `warp` (input classifier crates), and external projects (Microsoft inshellisense, Fig / Amazon Q CLI). All file:line refs verified against the local checkouts at audit time.

---

## 0. TL;DR (tiếng Việt)

**Hai feature:**
1. **History-only next-command** — gợi ý nguyên câu lệnh kế tiếp **chỉ từ history**, không gọi LLM. Kiểu fish/zsh-autosuggestions: gõ prefix → ghost text mờ → `→` để nhận.
2. **Input classifier** — đoán bạn đang gõ **lệnh shell hay câu hỏi AI**, bằng heuristic (không ML), để route. Chỉ hữu ích khi đã có "đích AI" (NL→command qua `vscode.lm`).

**Vấn đề cốt lõi:** AT là terminal **thụ động** — shell tự echo và **sở hữu dòng nhập**. AT chỉ biết dòng lệnh **lúc Enter** (OSC 633 `E`), không biết đang-gõ-gì theo từng phím. Cả hai feature đều cần nội-dung-đang-gõ realtime.

**Quyết định kiến trúc:** **KHÔNG** thay line editor của shell (cách Warp — mất zsh plugins/vi-mode/Tab-complete, rủi ro cao). Thay vào đó **OVERLAY**: đọc xterm buffer để dựng lại dòng đang gõ + vẽ gợi ý chồng lên trên. Giữ nguyên 100% UX shell. Đây là cách VS Code, inshellisense, Fig đều làm.

**Tin tốt:** phần khó nhất (đọc dòng đang gõ) **đã có code viết sẵn** trong vscode — class `PromptInputModel`, ~680 dòng, self-contained, port gần như nguyên xi. AT đã có sẵn 2 tiền đề khó nhất: parse OSC 633 A/B/C/D/E + webview xterm v6.

**xterm.js KHÔNG có API ghost text sẵn** — phải tự vẽ bằng DOM overlay (khuyến nghị) hoặc decorations API.

---

## 1. The two features (precise definitions)

### 1.1 History-only next-command (fish-style ghost text)
Suggest the *next whole command* from local history as dim ghost text after the cursor; accept with `→`. **No LLM** — pure prefix match against a history store. Warp ships this as a path parallel to its LLM path (`HistoryBasedAutosuggestionState`, `app/src/ai/predict/next_command_model.rs:67-72`). **Independently valuable** — needs no AI at all.

### 1.2 Input classifier (heuristic, no ML)
Decide, per keystroke, whether typed text is a **shell command** or a **natural-language AI request**, to route it. Warp's heuristic impl (`crates/input_classifier/src/heuristic_classifier/mod.rs:42-158`): count natural-language words against embedded dictionaries (`natural_language_detection/src/lib.rs:36-81`), stem them, subtract shell-syntax tokens, compare NL ratio to tuned thresholds; allowlists force `git/claude/codex/gemini` → shell and `hello/explain/what` → AI (`util.rs:14-124`). Runtime adds a history fuzzy-match short-circuit and a "follow-up to AI (yes/continue/approve)" signal (`app/src/ai/blocklist/input_model.rs:788-844`).
**Dependency note:** the classifier is just a *router*; it is useless until there is an AI destination (NL→command via `vscode.lm`). Build it *after* §1.1, paired with an AI input surface.

---

## 2. The core problem: passive terminal ≠ owns the line editor

In AT today: keystroke → xterm `onData` → node-pty → shell line editor (readline/zle/fish) echoes → back through PTY → xterm renders. **The shell draws and edits the input line; AT is a pipe.**

AT *does* parse OSC 633 `E` → `commandLine` event (`src/pty/oscParser.ts:262`), but shell integration emits `E` **only right before Enter** (the final line), not per keystroke. So AT cannot get the in-progress input from OSC alone.

This forks the design:

| Approach | What it is | Cost | UX impact |
|---|---|---|---|
| **(B) Replace the line editor** (Warp model) | AT owns an input widget; keystrokes go to AT, not the shell; send command on Enter; raw-passthrough mode for TUI apps | Very high (dual-mode, prompt-compat forever) | **Loses** zsh plugins, vi-mode, native Tab-complete, `Ctrl+R` — exactly the power-user UX the research flags as critical |
| **(B′) Overlay, don't replace** (VS Code / inshellisense / Fig) | Shell keeps owning input; AT *reads* the rendered buffer to reconstruct the line, and *overlays* suggestions | Medium | **Loses nothing** — all shell editing intact |

**Decision: (B′).** (B) is explicitly rejected — see `docs/ai-features-warp-cmux.md` for the full Warp dual-mode analysis. What's NOT lost in (B′): scrollback, colors, links, WebGL, all TUI apps (those are pure xterm and untouched).

---

## 3. Precedents — this is a solved pattern

| Project | Stack | Overlay mechanism | License | Relevance |
|---|---|---|---|---|
| **VS Code terminal suggest** (local source) | TS, xterm.js v6, passive PTY | Reads buffer via `PromptInputModel`; renders a **DOM dropdown**; **detects** (does not draw) the shell's ghost text via cell style | MIT | ⭐ Same architecture as AT. The reference impl. |
| **[microsoft/inshellisense](https://github.com/microsoft/inshellisense)** | **TS + Node + node-pty** | Wraps shell in a PTY; OSC protocol marks prompt boundaries; feeds the line into Fig's `@withfig/autocomplete` spec engine; renders own menu. 8 shells, cross-platform | MIT | ⭐⭐ Near-twin of AT's stack. Clone & read first. |
| **[aws/amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli)** (ex-Fig) | Rust + webview | `figterm` headless PTY intercepts the edit buffer; **both** dropdown **and** inline ghost text; overlay positioned via macOS Accessibility API | MIT/Apache | UX reference: ghost text + dropdown as *independent* features, accept with `→`/Tab |
| [withfig/autocomplete](https://github.com/withfig/autocomplete) | TS specs | declarative completion-spec DB (also what Warp & inshellisense use) | MIT | Optional spec source for arg/flag completion |

**Honest caveat:** overlay is proven but has real edge-case cost — Fig has documented rendering glitches (covers text behind it) on some terminals, and the xterm/Ghostty threads confirm naïvely writing ghost text into the buffer "messes it up." Mitigation = render as overlay, never into the buffer (§5).

---

## 4. The portable asset: `PromptInputModel` (reading the in-progress line)

The hardest part — reconstructing what the user has typed, per keystroke, in a passive terminal — **already exists** in vscode and is self-contained (depends only on xterm types + a logger). Port it near-verbatim.

**File:** `vscode/src/vs/platform/terminal/common/capabilities/commandDetection/promptInputModel.ts`

- **Re-sync triggers:** `onCursorMove`, `onData`, `onWriteParsed` (lines 121-125), coalesced via `@throttle(0)` (line 273) — runs per keystroke.
- **Start anchor:** on command start, stores `_commandStartMarker` (an xterm `IMarker`) + `_commandStartX = buffer.active.cursorX` (lines 207-230).
- **`_doSync` (lines 282-458):** `value = line.translateToString(true, _commandStartX)` (297); cursor index via `_getRelativeCursorIndex` (314-315, 669-671); walks wrapped lines (`isWrapped`) vs continuation-prompt lines, trimming PS2 (322-367); scans below cursor for full multi-line value (370-384); trailing-whitespace reconciliation using `_lastUserInput` (backspace `\x7F`, delete `\x1b[3~`, space) (390-448).
- **Right-prompt detection:** `_isPositionRightPrompt` = "5+ spaces before a styled run" (599-616).
- **Ghost-text detection (the shell's own):** `_scanForGhostText` (468-520); `_isCellStyledLikeGhostText` = `cell.isItalic() || cell.isDim()` (673-675); advanced contiguity scan `_scanForGhostTextAdvanced` (522-593).
- **Exposed state** `IPromptInputModelState` (47-69): `value` (incl. ghost text), `prefix` = value up to cursor **excluding** ghost text (93, 55-56), `suffix`, `cursorIndex`, `ghostTextIndex` (-1 when none).

**Why it's robust:** it reads the *rendered result*, so it's correct regardless of how the shell edited the line (backspace, arrows, `↑` history recall, `Ctrl+R`). No keystroke prediction.

**Gating:** lives inside `CommandDetectionCapability` (`commandDetectionCapability.ts:87`, `:357-359`); without a command-start marker `_doSync` early-returns (283-285). **The whole thing requires shell integration (OSC 633).** See §7.

---

## 5. Rendering the suggestion — xterm.js has NO ghost-text API

**xterm.js v6 ships no `setGhostText()` / hint API / autosuggest addon.** You compose primitives. Note also: **VS Code itself does not draw terminal ghost text** — that ghost text is the *shell's* (PSReadLine / zsh-autosuggestions); VS Code only detects it and draws its own *dropdown*. If AT wants to provide ghost text from its *own* history (so users need no shell plugin), AT must render it itself, via one of:

| Mechanism | How | Verdict |
|---|---|---|
| **(a) Write dim text into the buffer** | `term.write('\x1b[2m'+sug+'\x1b[0m')`, erase before next keystroke | ❌ Pollutes buffer; must clear-to-EOL every keystroke; **fights the shell's echo** on the same line. The "messes up the buffer" pitfall. Avoid in a passive terminal. |
| **(b) Decorations API** | `registerDecoration({marker, x})` → a DOM element anchored to a cell, scrolls with content, no buffer write (`xterm.d.ts:1274`, `IDecoration` 593, `IDecorationOptions` 633) | ⚠️ Works, no buffer pollution, but designed for gutter/cell marks; row-anchored so exact-column inline text is fiddly. |
| **(c) Own DOM overlay** | Absolutely-position a dim `<span>` over `.xterm-screen` at `cursorX/cursorY × cellDims` | ✅ **Recommended.** Cleanest, full control, no buffer write. Exactly how VS Code positions its dropdown (`terminalSuggestAddon.ts:_getCursorPosition` 717-728; cell dims from `_core._renderService.dimensions.css.cell` 706-715). Cost: reposition on scroll/resize; cell-dim read is semi-private. |

**Two variants of "where does ghost text come from":**
- **Detect the shell's** (VS Code way): zero drawing — but requires the user to run `zsh-autosuggestions`/fish. AT just detects (§4) + accepts by sending `→`.
- **Draw your own from history** (Fig/inshellisense way): AT controls it, no user plugin needed — **this is AT's goal** — via (c).

---

## 6. Accept / dismiss / Tab — never steal Tab from the shell

VS Code's pattern (`terminalSuggestAddon.ts`):
- **Accept writes bytes to the PTY, never mutates the buffer** (`acceptSelectedSuggestion` 939-1043): emit `\x7F` (backspace) × extra chars, `\x1b[3~` (delete) × right-word chars, then the suffix, optional `\r` (1006-1023). For accepting the shell's own ghost text it sends `\x1b[C` (`→`) (159). The shell then re-echoes — so the buffer stays the single source of truth.
- **Tab is context-gated:** the accept keybinding binds `Tab` only `when: HasFocusedSuggestion` (549-553). No focused suggestion → Tab falls through to the shell's native completion. **This is the whole reason the approach is non-invasive.**
- **Dismiss:** `Escape` (578-589); space hides (620-626); cursor-left invalidates (632-637).

For AT (webview): the input never goes through AT, so AT intercepts the accept key (`→`/Tab) in the webview *only while a suggestion is shown*, sends the completion bytes to the PTY, and otherwise lets the key pass through to the shell.

---

## 7. Shell-integration gating + fallback

Everything here depends on OSC 633 (the command-start marker). AT already parses it (`src/pty/oscParser.ts:220-264`). When shell integration is **absent or not firing** (sub-shells, plain SSH, exotic prompt setups — see PLAN.md §7.2):
- No marker → `PromptInputModel` can't reconstruct the line → **suggest is silently disabled** (do not fake it from keystroke heuristics — false positives are worse than absence).
- Reuse the Phase-3 "shell integration active/inactive" status indicator (PLAN.md §3.2). Suggest is one more feature gated on that flag.

---

## 8. AT readiness map

| Needed | AT already has | Gap |
|---|---|---|
| OSC 633 A/B/C/D/E parsing | `src/pty/oscParser.ts` (`commandStart` on B/C `:225`, `commandEnd`+exit `:231,239`, `commandLine` on E `:262`) | Forward A/B markers to the webview model (currently host-side only) |
| xterm v6 webview | `package.json:564,568`; `registerOscHandler(7)` already used (`TerminalFactory.ts:416`) | — |
| Command history source | commands captured via OSC 633 lifecycle | A persisted history store (cwd/exit/timestamp), per-workspace augmentation (PLAN.md §5.2) |
| Buffer reading APIs | xterm v6 public: `buffer.active.getLine/translateToString` (`xterm.d.ts:1665,1749`), `cursorX/Y` (1637/1631), `registerMarker` (1264), `onCursorMove/onWriteParsed` (1047/1089), cell `isItalic/isDim` (~1772-1820), `registerDecoration` (1274) | — (all present) |
| `vscode.lm` (for the classifier's AI destination only) | engine `^1.105.0` (`package.json:33`) | Only needed when §1.2 ships |

---

## 9. Recommended implementation order

1. **History store + capture** — persist accepted commands (from OSC 633) with cwd/exit/timestamp; per-workspace file (PLAN.md §5.2). *Independent, no UI risk.*
2. **Port `PromptInputModel`** into the webview — wire AT's A/B/C/D/E events into it; expose `{prefix, cursorIndex}`. *The load-bearing step.*
3. **History ghost text via DOM overlay (c)** — on each sync, prefix-match newest history → render dim `<span>` at cursor; `→` accepts (send remaining bytes to PTY). Gate on shell-integration-active.
4. **Suggestion dropdown** (optional) — reuse the cursor-position math for a small DOM widget; Tab gated on focused-suggestion.
5. **Per-directory history ranking** (PLAN.md §5.2) — boost commands previously run in the current cwd (AT has cwd via OSC 7 / OSC 633 P).
6. **Input classifier (heuristic)** — only once an AI destination exists. Port Warp's heuristic + dictionaries to TS; pair with an AI input surface (`Cmd+K` floating AI box is the low-risk way to avoid the line-editor problem entirely — see §10).

---

## 10. Open risks / decisions

- **Classifier needs an AI input surface.** With (B′) overlay you still type straight into the shell, so there's no natural spot to "switch to AI mode." Recommended: a **separate `Cmd+K` AI input** (an AT-owned floating box) rather than auto-detecting on the shell line. Loses Warp's "magic" auto-switch but sidesteps the line-editor problem completely.
- **Exotic prompts.** powerlevel10k (instant/transient prompt), starship, RPROMPT, multi-line PS1/PS2 — `PromptInputModel` handles many cases but this is where VS Code/inshellisense still patch bugs. Test matrix required before shipping.
- **Decoration/overlay perf** under heavy output / fast scroll — historically a sore spot in xterm.js. Benchmark.
- **Buffer-read column accuracy** — `_commandStartX` capture must happen at the exact B marker; verify against AT's host→webview event timing (the parser is host-side, the buffer is webview-side).

---

## 11. External deep-research prompt (for going deeper than local source)

> I'm building fish-style history autosuggest (inline ghost text + suggestion dropdown) for a custom VS Code terminal extension. Stack: TypeScript, xterm.js v6 webview, node-pty host, passive PTY (the shell owns the line editor). I will NOT replace the shell's line editor — overlay only, like VS Code's terminal suggest, Microsoft inshellisense, and Fig/Amazon Q CLI. I plan to reconstruct the current command line by reading the xterm buffer from the OSC 633 command-start marker to the cursor (VS Code's `PromptInputModel` approach) and render ghost text via a DOM overlay (not by writing to the buffer).
>
> Research and report, with sources and concrete code references:
> 1. Robustness of buffer-reading across exotic prompts: powerlevel10k (instant + transient prompt), starship, RPROMPT, multi-line PS1, continuation PS2, bracketed paste. What breaks; how VS Code / inshellisense mitigate it; link issues.
> 2. Rendering ghost text overlay in xterm.js v6 without polluting the buffer: decorations API vs absolutely-positioned DOM — known perf regressions, dropped-frame issues, behavior under heavy output / fast scroll; any community addons.
> 3. Shell-integration auto-injection success rate in the wild (zsh+oh-my-zsh, bash, fish, pwsh): when OSC 633/133 fails to fire (sub-shells, SSH, custom prompts) and the graceful fallback for a feature gated on it.
> 4. How inshellisense and Fig/figterm reconstruct the edit buffer and position the overlay; trade-offs vs in-webview xterm-buffer reading.
> 5. Accept/keybinding design that never steals Tab from native shell completion; how each tool gates Tab/Right/Esc.
> 6. Other OSS doing inline terminal suggestion as an overlay (Hyper plugins, Tabby, Wave, Warp, ble.sh, Atuin) — architecture and pitfalls.

---

## 12. Source reference index

**vscode (overlay impl):** `src/vs/platform/terminal/common/capabilities/commandDetection/promptInputModel.ts` (121-125, 207-230, 282-458, 468-593, 599-616, 669-675), `commandDetectionCapability.ts:87,357-359`, `src/vs/workbench/contrib/terminalContrib/suggest/browser/terminalSuggestAddon.ts` (155-167, 210-230, 549-553, 578-637, 664-728, 939-1043), `terminalCompletionService.ts:136-243`, `terminal.suggest.contribution.ts:124-182`.

**xterm.js v6 typings:** `typings/xterm.d.ts` — onCursorMove 1047, onWriteParsed 1089, onData 1041; buffer.active.getLine 1665, translateToString 1749, cursorX 1637 / cursorY 1631; IBufferCell isItalic/isDim ~1772-1820; registerMarker 1264; registerDecoration 1274 / IDecoration 593 / IDecorationOptions 633; parser.registerOscHandler, registerCsiHandler 1954.

**warp (classifier + history path):** `crates/input_classifier/src/{lib.rs:52, heuristic_classifier/mod.rs:42-158, util.rs:14-124}`, `crates/natural_language_detection/src/lib.rs:36-81`, `app/src/ai/blocklist/input_model.rs:788-844`, `app/src/ai/predict/next_command_model.rs:67-72`.

**AnyWhere Terminal:** `src/pty/oscParser.ts` (220-264, esp. 225/231/239/262), `src/pty/ShellIntegrationEvents.ts:19-25`, `src/webview/terminal/TerminalFactory.ts:416`, `package.json:33,564,568`.

**external:** [microsoft/inshellisense](https://github.com/microsoft/inshellisense) ([DeepWiki](https://deepwiki.com/microsoft/inshellisense)), [aws/amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli), [withfig/autocomplete](https://github.com/withfig/autocomplete).
