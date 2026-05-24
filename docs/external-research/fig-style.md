# Should AnyWhere Terminal Ship Fig-Style Autocomplete? A Decision Brief

## TL;DR

- **Conditional-Go**, narrowly scoped. Ship a **Ctrl-Space–triggered, never-default-on, never-Tab-stealing** popup that consumes `@withfig/autocomplete` specs (MIT, 25.1k★, last meaningful activity May 2025) for **10–20 high-value CLIs** (git, gh, docker, kubectl, npm/pnpm/yarn, cargo, terraform, aws, gcloud, brew, ssh, make) on **zsh + bash** for macOS. Anything wider loses to Microsoft on cost, narrower loses to "why bother."
- **The competitive moat is UX discipline, not specs.** Microsoft's built-in Terminal Suggest, default-on since VS Code v1.106 (Oct 2025), uses the same Fig specs and is being actively complained about by power users (issues #279538, #283496, #282958, #282268). AT's differentiation is "the autocomplete that respects your muscle memory."
- **The biggest strategic risk is irrelevance, not Microsoft.** Within 6–12 months Microsoft will likely fix Tab/granularity complaints in core. The Go-decision only makes sense if Fig-style completion is **one pillar** of broader AT differentiation (drag-drop file tree, hover preview, custom rendering), not the whole product.

---

## 1. Fig Ecosystem State, May 2026

**Verified:**
- `withfig/autocomplete` is **MIT-licensed** (Copyright 2021 Hercules Labs Inc., LICENSE file) — fully redistributable, including commercially, inside a VS Code extension.
- **25.1k stars, 5.5k forks** on GitHub org page (May 2026). Repo holds *"IDE-style autocomplete for your existing terminal & shell."* Last major activity logged on the org page: **May 5, 2025**. Still accepts PRs (e.g., PR #292894 updating `azd` spec in 2025), but velocity has decelerated sharply post-AWS acquisition.
- Fig's own marketing site cites **"500+ popular CLI tools"** (fig.io/user-manual/autocomplete). The ToolMage retrospective records that at sunset Fig had *"over 22,000 GitHub stars, and hundreds of open-source contributors."*
- **Fig the standalone product was sunset September 1, 2024** (announced by co-founder Brendan Falk; mirrored on AlternativeTo). The `withfig/fig` issue-tracker repo was **archived March 13, 2025**.
- **Successor: Amazon Q Developer for command line** (`aws/amazon-q-developer-cli` and `aws/amazon-q-developer-cli-autocomplete`, dual MIT + Apache-2.0). README confirms *"Amazon Q Developer CLI, formerly known as Fig, is open source"* and the autocomplete repo continues to use the same Fig spec format. **macOS only**, with experimental Linux; **no Windows**. No first-party public-Marketplace VS Code extension exists for the CLI-autocomplete piece — the `amazonwebservices.codewhisperer-for-command-line-companion` VSIX is side-loaded by the Amazon Q desktop helper and only signals terminal focus to the macOS overlay.

**Engineering reasoning:** The Fig spec corpus is essentially a **2024-vintage frozen-ish public good**. Many new CLIs and modern flags will lag. AT can offset this with a thin local-override layer (`~/.at/specs/*.ts`).

**Alternatives examined:**
- **Carapace** (`carapace-sh/carapace-bin`): **1,806 stars, MIT** (GitHub org page, May 4 2026: *"1,806 MIT 114 forks"*); DeepWiki Key Features page (deepwiki.com/carapace-sh/carapace-bin/1.1-key-features) states: *"Carapace-bin includes over 1600 built-in completers for popular CLI tools."* YAML spec language (`carapace-spec`), Go binary, multi-shell, very actively maintained. **A viable substitute** for Fig specs if Fig stagnates further; the binary even bridges to bash/zsh/fish/pwsh native completion.
- **Microsoft `inshellisense`**: GitHub Security page reads *"Fork 219 · Star 9.8k"* (May 2026); MIT; last release `0.0.1-rc.31` on **Jan 25, 2026** (author `cpendery` / Chad Pendery, Microsoft). It is a **standalone CLI/TUI** (`npm install -g @microsoft/inshellisense`), not a VS Code extension. Vendors the Fig spec corpus. README explicitly: *"Specs for the az, gcloud, & aws CLIs are not supported in inshellisense due to their large size."* — useful signal for AT's bundle budget.

---

## 2. Microsoft Terminal Suggest — Lessons From Failure

**Verified timeline:**
- **VS Code v1.98 (Feb 2025)**: *"We leverage Fig completion specs to power intelligent completions for specific CLIs"* (release notes; cited in subagent finding).
- **VS Code v1.106 (Oct 2025, released Nov 12 2025)** — the inflection point. Release notes (per subagent fetch): *"Terminal IntelliSense has been in the product as an experimental/preview feature for around 1.5 years! This release we're removing the preview tag and will be doing a staged roll out as the default to all users on stable."*
- Subsequent walk-back covered by How-To Geek: *"It's still enabled by default, but suggestions are now hidden unless you press Ctrl+Space."* Microsoft acknowledged: *"During the past two releases, we rolled out terminal IntelliSense to all VS Code Stable users. While much of the feedback was positive, there was a segment of users (mostly terminal power users) that did not like the feature breaking their muscle memory."*
- Most recent located: **VS Code v1.121 (May 2026)** — release focus is Mermaid/HTML previews, agents; no Terminal Suggest overhaul listed (releasebot.io feed, May 6 2026). The brief asked about Q1-Q2 2026 fixes for Terminal Suggest — **no major Terminal Suggest milestone in 2026 was found** beyond the post-1.106 cleanup. This actually *reduces* near-term competitive pressure but means power-user complaints remain unfixed.

**Concrete complaint taxonomy (verbatim from issues):**

| Category | Issue | Quote |
|---|---|---|
| Tab steals, breaks muscle memory | **#279538** (Nov 26, 2025) | *"It completes in a Windows-style manner—filling in what it assumes is best—rather than following the Linux-style approach…I had to disable the entire feature."* |
| No per-command granularity | **#283496** (Dec 15, 2025) | *"I'd like, as an example, to disable the feature just for file/folder selection ; or just for the cd command."* |
| Default-on intrusion | **#282958** (Dec 12, 2025) | *"Terminal intellisense is being pushed down out throats by having terminal.integrated.suggest.enabled defaulting to true."* |
| Non-bash-like path completion | **#282268** | *"When I type `git add sr + <TAB>` I expect it to behave similar to bash, where it auto completes up to `src/`…[VS Code] prefers to auto complete an entire path rather than stopping at a branch point."* |
| Visual duplication w/ Inshellisense | **#248639** (May 2025) | *"Random visual duplication of terminal content when repeating history commands. Happens only inside VSCode's integrated terminal with Inshellisense enabled."* |
| Spec quality on pwsh | **#239425** | Fig specs leak bash-isms (e.g., `cat`) into PowerShell suggestions. |

**Closed-as-duplicate feature request:** Issue **#210277** ("Feature Request: Tab Autocomplete in Integrated Terminal", Apr 12, 2024) — duplicate of the work that became Terminal Suggest.

**Key takeaway:** Microsoft already uses Fig specs; the failure mode is **UX policy**, not spec quality. AT's opportunity is not a better spec engine but a less-annoying interaction model.

---

## 3. Competitive Landscape

| Solution | Form | Reach | Last update | Approach | Fig-style in *VS Code terminal*? |
|---|---|---|---|---|---|
| **VS Code Terminal Suggest** (built-in) | Core feature | ~whole VS Code userbase | Default-on since v1.106 (Oct 2025) | xterm.js `SuggestAddon` reading OSC 633 shell-integration; Fig specs vendored in `extensions/terminal-suggest/` | **Yes — this is the incumbent** |
| `microsoft/inshellisense` | Standalone CLI/TUI | 9.8k★ | RC 0.0.1-rc.31, Jan 25 2026 | Spawns sub-shell, draws TUI popup, intercepts keys | No (CLI only) |
| `kiriko.fig-unreleased` ("Fig Files Intellisense") | VS Code extension | **3,257 installs** (Marketplace badge, subagent fetch) | Unknown | Editor-side `CompletionItemProvider` over `.sh`, `package.json`, GH Actions | **No — editor files, not terminal** |
| `tetradresearch.vscode-h2o` | VS Code extension | Not surfaced | v0.2.15 (VsixHub) | h2o-generated CLI completion in `.sh` files | **No — editor files** |
| Amazon Q Developer CLI | macOS desktop helper + side-loaded VSIX | n/a public | Active 2025–26 | Accessibility-API overlay; the side-loaded VSIX only signals focus | macOS desktop overlay; not pure VS Code |
| Warp terminal | Standalone macOS/Linux app | warp.dev homepage (May 2026): *"Trusted by over 800,000 developers and thousands of engineering teams at leading companies"* | Continuous; open-sourced under AGPL-3.0 in April 2026 | Native Rust + GPU; warp.dev/modern-terminal: *"Warp suggests commands, flags, and arguments for 400+ CLI tools. No extra setup — just start typing."* Tab rebindable; "Open completions menu as you type" opt-in | Not in VS Code; **important UX reference** |
| Ghostty | Standalone terminal | n/a | n/a | Relies on shell-native completion; no first-party Fig-style popup | No |

**No third-party VS Code extension currently ships Fig-style popup completion *inside the integrated terminal*.** That's both the opportunity and the warning. Opportunity: the lane is empty. Warning: Fig themselves never shipped one — they only shipped a macOS native overlay that happened to work above VS Code's terminal via accessibility APIs. The empty lane has a reason: the technical contract between an extension, xterm.js, and node-pty is awkward.

---

## 4. Technical Architecture Options

### Option A — Side-channel completion (RECOMMENDED for MVP)
Extension owns the popup widget, taps keystrokes via xterm.js `attachCustomKeyEventHandler` (xterm.js docs: *"giving consumers of xterm.js ultimate control as to what keys should be processed by the terminal and what keys should not"*), maintains a parallel input buffer, parses against Fig specs, renders DOM overlay positioned with xterm cursor coords. **PTY remains unaware.**

- **Pros:** Single implementation, no shell-specific code, works on any shell. Microsoft's own `SuggestAddon` takes this shape; inshellisense uses a TUI variant.
- **Cons:** Buffer can desync with paste, alias expansion, history substitution, alt-screen apps (vim, less). Must detect application mode and disable.
- **Known pitfall:** xterm.js issue **#3880** documents that `attachCustomKeyEventHandler` does **not** override all xterm built-in shortcuts. Keep your trigger key (Ctrl-Space) outside xterm's reserved set.

### Option B — Shell integration via OSC sequences
Inject a zsh widget / bash readline binding / `PSReadLine` handler that emits OSC-633-style sequences carrying buffer + cwd + cursor; extension parses via `parser.registerOscHandler`.

- **Pros:** 100% accurate state, knows cwd/env/last exit code natively, handles aliases. This is what VS Code's shell-integration already does.
- **Cons:** Per-shell implementation. Fragile across user shell configs (oh-my-zsh, starship, p10k — inshellisense issue threads confirm breakage). Must coexist with VS Code's own shell integration to avoid double-binding.
- **Verdict:** Best long-term, 2× implementation cost. **Defer to v2.**

### Option C — PTY proxy (do NOT do)
Full input tokenization between user and pty. node-pty issue #71 thread confirms you can't differentiate stderr/stdout in a pty, and the surface area for breaking interactive programs (vim/less/ssh/fzf) is huge. Carapace and Fig-the-app use a variant; not viable inside a VS Code extension.

### Dynamic completion (git branches, docker images, npm scripts)
Fig specs handle this via `Generator` objects specifying a shell script. **Engineering reasoning:** spawn `git branch --list --format=%(refname:short)` in background via `child_process` (NOT the user's pty), cache by `{cwd, mtime of .git/refs}` with 5-second TTL. Fig issue **#2026** ("git branches suggestions still appear after being deleted") proves cache invalidation is the hard part — even Fig got it wrong.

### Conflicts with existing AT features
The popup is a DOM overlay; positioning collides with hover-preview popups and file-drag visual feedback. **Engineering reasoning:** introduce a popup-priority manager and dismiss-on-other-popup behavior. Not architecturally hard but a real test-matrix burden.

---

## 5. UX Design — Don't Repeat Microsoft's Mistakes

**Verified anti-patterns:**
- **Never bind Tab by default.** Issue #279538 is the canonical complaint. Warp docs (docs.warp.dev/terminal/command-completions/completions/): *"The 'Tab key behavior' setting under Settings > Features > Terminal Input can change the action that Tab is bound to. If Tab is not bound to open the completions menu, ctrl-space will be assigned as the default keybinding."*
- **Never auto-show on every keystroke.** Microsoft tried it, walked it back. Warp ships *"Open completions menu as you type"* as opt-in.
- **Never default-enable.** Issue #282958 exists because Microsoft defaulted-on.

**Recommendation matrix:**

| Decision | AT default | Rationale |
|---|---|---|
| Trigger | **Ctrl-Space** (configurable to Tab) | Matches Warp; avoids #279538 |
| Auto-show | **Off**; opt-in "Open as you type" | Matches Warp |
| Tab behavior | **Pass through to shell**, unless popup is visible (then Tab accepts) | Preserves muscle memory |
| First-run default | **Opt-in** with onboarding card | Post-Dec-2025 trust climate |
| Visual | DOM popup at cursor + optional inline ghost text | Matches both VS Code core and Warp |
| Per-command disable | **Yes from v1.0** | #283496 explicitly asks; Microsoft doesn't have it |
| Application-mode detection | Auto-disable in vim/less/ssh/fzf | Critical; no clean precedent — empirical work needed |

**Per-shell support (MVP):** zsh ✅, bash ✅, fish v1.1, pwsh v2.0 (spec quality is poor — #239425), nushell ❌, cmd ❌ (out of scope for macOS-only AT).

---

## 6. Performance & Bundle

**Verified data:**
- `@withfig/autocomplete-types` package: **64.4 kB**, 1,639 weekly downloads, MIT (npm registry).
- Inshellisense excludes az, gcloud, aws specs *"due to their large size"* (README).
- The full Fig spec corpus ships inside VS Code core, but exact byte size is undisclosed.

**Engineering reasoning for AT:**
- Full corpus estimate: **5–15 MB compiled JSON** (Speculation; measure during spike). Unacceptable as static load.
- **Required pattern: lazy-load by detected first token.** Bundle a tiny manifest mapping `git → git.js`, fetch the spec module on demand. First-terminal cold-start: zero spec loading.
- Cache parsed specs across terminal instances (module-level).
- Generator results: cache `{generator-id, cwd}` with 5-second default TTL; invalidate on `command-finished` OSC.

**Performance targets to commit to:**
- Cold extension activation: < 50 ms added to terminal open.
- First popup after Ctrl-Space: < 80 ms.
- Resident memory for typical 5-spec session: < 30 MB. *(Speculation; measure.)*

---

## 7. Demand Quantification

**Verified signals:**
- **Show HN: Inshellisense — IDE style shell autocomplete** (news.ycombinator.com/item?id=38167363, posted by `cpendery` on **Nov 6, 2023**): **388 points, 148 comments**. Strong intent signal.
- `microsoft/inshellisense`: **9.8k★** in ~2.5 years (GitHub).
- `withfig/autocomplete`: **25.1k★** — top-decile dev-tool repo.
- VS Code issue **#210277** ("Tab Autocomplete in Integrated Terminal", Apr 2024) closed as duplicate — enough duplicate requests to consolidate.
- Multiple 2025–2026 blog posts (medium.com/@360rishabsvjc, preslav.me Dec 16 2025, brightcoding.dev Sep 2025) on enabling/disabling Terminal Suggest = ongoing attention.

**Data gaps (honest):**
- Subagent confirmed `site:reddit.com vscode fig autocomplete terminal` returned no usable threads with vote counts. Reddit de-indexing post-API-changes is a known problem.
- VS Code Marketplace install-counts are JS-rendered and not retrievable without authenticated API calls; only the kiriko.fig-unreleased page exposed its 3,257-installs badge in static HTML.

**Inference:** Demand is **real but ambient**. There's no rabid "give us Fig-in-VSCode" movement, but consistent friction with Microsoft's solution. Target user: "people who tried Terminal Suggest, hated it, disabled it, silently wished someone would do it better." Hard-to-reach but high-LTV.

---

## 8. Strategic Risk Matrix

| Actor | Risk | Likelihood (next 12 mo) | Mitigation |
|---|---|---|---|
| **Microsoft fixes Terminal Suggest** (Tab-opt-in + per-command disable) | High; they have the team, data, backlash | **~70%** | Differentiate beyond "less annoying"; build adjacent features |
| **Amazon Q ships first-party Marketplace VS Code extension** for CLI autocomplete | Already have macOS overlay; Marketplace step is incremental | **~30%** — AWS hasn't shown urgency outside chat | Watch `aws/amazon-q-developer-cli` PRs |
| **Warp ships VS Code extension** with autocomplete | April 2026 open-source pivot mentions "Warp Bridge VS Code extension" for *agent* MCP, not autocomplete | **~20%** they extend Bridge to include autocomplete | If they do, race ends; pivot AT |
| **Fig specs go stale** | Last major activity May 2025; CLI version-drift | **~80%** material drift on 5+ major CLIs/year | Build per-CLI override layer + user-defined local specs |
| **xterm.js v7 breaking changes** | Actively maintained; v6 already shipped | **~40%** API churn within 18 months | Encapsulate xterm coupling behind your own interface |

---

## 9. Effort Estimate

**Verified comparable:** `microsoft/inshellisense` is TypeScript-86.5%, ~16 contributors, 295 commits over ~2.5 years to reach "production preview" (still `0.0.1-rc.31`). That's *a working Fig-spec runtime + TUI*, no popup overlay or VS Code integration.

**Estimates (Speculation, explicitly flagged):**

| Milestone | Scope | Solo-dev calendar time | LOC estimate |
|---|---|---|---|
| **Prototype** | popup over xterm.js, Ctrl-Space, hardcoded git+npm spec, no dynamic gens | 2–3 weeks | 1.5–2k |
| **MVP / alpha** | 10 CLIs (git, gh, npm/pnpm/yarn, docker, kubectl, cargo, brew, ssh, curl), zsh+bash, dynamic git branches, settings | 6–10 weeks | 4–6k + vendored specs |
| **Beta** | 50 CLIs, per-command disable, app-mode detection, paste-safe buffer sync, accessibility | +3–4 months | 8–12k |
| **Stable / production** | 200+ CLIs lazy-loaded, custom user specs, fish, basic pwsh | +6 months | 15–25k + ~10 MB specs |

**Maintenance burden (Engineering reasoning):**
- Spec drift: ~4 hr/week merging upstream Fig PRs into vendor branch.
- VS Code API churn: monthly releases; budget 1 day/release for regression checks.
- xterm.js churn: 2× year, low if encapsulated.

---

## 10. Recommendation — Conditional Go

### Vietnamese strategic commentary

Đây là một quyết định **conditional go, không phải full go.** Bốn lý do:

1. **Cửa sổ cơ hội có thật nhưng hẹp.** Microsoft đã chiếm sân với Terminal Suggest từ v1.106 (10/2025) và họ dùng cùng bộ Fig specs. Bạn không thắng bằng chất lượng spec — bạn thắng bằng **UX kỷ luật**: không cướp Tab, không bật mặc định, cho phép tắt theo từng lệnh. Đây chính xác là những điều power users đang phàn nàn (#279538, #283496, #282958).

2. **Đừng đặt cược toàn bộ AT vào tính năng này.** Nếu AT chỉ là "Fig-in-popup," 6–12 tháng nữa Microsoft sẽ fix Tab và bạn mất giá trị duy nhất. Fig-style autocomplete chỉ nên là **một trong nhiều cột trụ** của AT (cùng drag-drop file tree, hover preview, custom rendering).

3. **Scope MVP cực chặt.** 10–20 CLIs (git, gh, docker, kubectl, npm/pnpm/yarn, cargo, terraform, brew, ssh, curl, make), **zsh + bash** trên macOS. Bỏ pwsh, nushell, cmd. Bỏ az/gcloud/aws full specs — Inshellisense cũng bỏ vì quá nặng.

4. **Tech choice:** Side-channel Option A (xterm.js `attachCustomKeyEventHandler` + DOM overlay), KHÔNG inject vào shell ở v1. Lazy-load specs theo CLI detect được. Generator chạy qua `child_process` riêng, cache TTL 5s.

5. **Build vs adopt:** Vendor `@withfig/autocomplete` (MIT) ngay từ đầu, attribute Hercules Labs Inc. Đừng tự viết spec từ con số 0. Có thể swap sang Carapace sau nếu Fig stagnates thêm.

### Staged plan with kill-switches

| Stage | Investment | Ship-if | Kill-if |
|---|---|---|---|
| **Stage 0: spike (1 wk)** | xterm.js key handler + DOM popup over real terminal; fake suggestions | Popup positions correctly across resize/font-change | Cannot solve cursor-positioning reliably |
| **Stage 1: prototype (3 wks)** | Real Fig spec parsing, git+npm+docker, Ctrl-Space only, opt-in | Internal dogfooding gives "I'd miss it" | Conflicts with hover-preview / file-drag |
| **Stage 2: alpha (8 wks)** | 10 CLIs, dynamic generators, settings UI | 100 alpha testers, NPS ≥ 30 | Microsoft ships Tab-opt-in *and* per-command disable in same window — you lose differentiation |
| **Stage 3: beta (3 mo)** | 50 CLIs, app-mode detection, fish | 1k installs in first month on Marketplace | Warp ships VS Code Bridge with autocomplete |
| **Stage 4: production (6 mo)** | 200+ CLIs, user-defined specs, polish | Sustained retention; community spec PRs | Maintenance > 8 hr/week with no revenue model |

### Concrete next steps (this week)

1. **One-day spike:** Confirm `attachCustomKeyEventHandler` + DOM overlay positioning works with AT's existing WebGL renderer. **Highest-uncertainty technical risk.**
2. **One-day legal/license review:** Confirm MIT redistribution of `withfig/autocomplete` is compatible with AT's license; add Hercules Labs Inc. attribution.
3. **Two-day prototype:** Hardcoded `git` spec, Ctrl-Space trigger, no dynamic generators. Validate the UX feels good. **If it doesn't feel materially better than VS Code Terminal Suggest v1.121, abort.**
4. **One-day competitive snapshot:** Manually test VS Code Terminal Suggest in v1.121 on your 10 candidate CLIs. Identify ≥5 concrete UX failures you will fix.

### If No-Go: cheaper alternative

If post-spike you decide against full Fig-style: **ship "smart Tab" instead.** Detect first-token CLI, shell out to `carapace _carapace export <cmd>` (1,806★ carapace-bin, 1,600+ tools, MIT), render the JSON as a simple completion list. Or run `<cli> --help` once, parse, cache. Estimated effort: **2–3 weeks total.** Less differentiated but serves the demand of "I want autocomplete but I don't want Microsoft's."

---

## 11. Caveats & Open Questions

- **Marketplace install-count data is JS-locked** (subagent confirmed). Hard numbers for `kiriko.fig-unreleased` (3,257), `tetradresearch.vscode-h2o`, and the Amazon Q VSIX are partial. For v2 of this analysis use the Marketplace REST API.
- **Reddit signal is largely de-indexed.** Could not surface specific thread upvotes. Recommend a dedicated Reddit-search day before final commit.
- **VS Code release-numbering note:** the brief asked about Q1–Q2 2026 Terminal Suggest fixes; the substantive flip happened in **v1.106 (Oct 2025)**, with refinements in subsequent monthly releases. As of v1.121 (May 2026) the focus has shifted to agents/AI — **no major Terminal Suggest overhaul in May 2026 was found**. Reduces short-term competitive pressure but means power-user complaints remain unfixed.
- **No verified bundle-size number** for the full compiled Fig spec corpus. The 5–15 MB estimate is engineering reasoning, not measurement. Measure during spike.
- **Application-mode detection** (don't show completion inside vim/less/ssh) has **no clean precedent** in the literature found. Will require empirical work and a kill switch.
- **Spec-quality drift on 2025-vintage CLIs** (Bun, Deno modern flags, fnm, mise) is not measured. Sample 10 popular 2025-vintage CLIs and check Fig spec freshness before committing to "Fig is enough."
- **AGPL-3.0 of Warp's client** does *not* infect AT (different process), but if you ever consider integrating Warp's spec engine, that becomes a licensing event.
- **Inshellisense's RC numbering after 2.5 years** (`0.0.1-rc.31`) is a soft signal that the maintainer himself doesn't consider it production-ready — interpret your own effort estimates accordingly.
- **node-pty stderr/stdout aren't separable in a pty** (microsoft/node-pty #71, designed as such) — confirms Option C is infeasible and reinforces Option A as the only practical MVP path.