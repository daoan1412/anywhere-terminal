# AnyWhere Terminal — Top 3 User-Demanded Features

> **Status:** Strategic prioritization extract — derived from `PLAN.md` (v0.11.4) and source research (`custom-claude.md`, `custom-gpt.md`, evaluation session 2026-05-24).
>
> **Scope:** 3 features with strongest evidence of unmet user demand, ranked by signal weight (issue age × install counts × cross-source corroboration).
>
> **Purpose:** Use this as a "what to build for maximum user impact" reference. Pair with `PLAN-quick-wins.md` for execution sequencing.

---

## Evidence Ranking Methodology

Each feature scored on three axes:

1. **Demand signal strength** — issue age, comment count, install counts of partial-solution extensions
2. **Microsoft absorption risk** — likelihood VS Code core ships this in next 6-12 months
3. **AT positioning fit** — does it reinforce "workflow orchestration" thesis or pull sideways

---

## #1 — Session / Buffer Restore

**Evidence weight:** 🔴🔴🔴🔴🔴 (highest in entire research corpus)

### Why this is #1

| Signal | Value |
|---|---|
| Canonical issue age | Open since **2018** (`microsoft/vscode #44302`) |
| Microsoft posture | Daniel Imms (Tyriar, terminal lead): *"We have no plans on restoring sessions like this. Instead we're opting for extensions like Terminals Manager to take up this role."* |
| Adjacent extension installs (sum) | **~400k installs** — Terminal Keeper (222k) + Restore Terminals (108k) + Terminals Manager (74k) |
| Issue cluster | `#44302` (restore), `#128001` (workspace-specific, labeled `extension-candidate`), `#131634` (process revive), `#123518` (60s SSH disconnect window) |
| Cross-source corroboration | Both `custom-claude.md` §1.1 rank #1 AND `custom-gpt.md` cụm "Phiên & khởi tạo" largest cluster |

**Verified [PLAN.md §2, §5.3].** This is the highest-signal opportunity in the entire research corpus.

### Critical execution warning

**User actually wants process revive, not buffer restore.** Direct quote from bpasero (Microsoft VS Code team) in `#44302`: *"my biggest use case is to reconnect to a running 'npm run watch'"*. *[Verified — PLAN.md §13.B mapping]*

This means:
- **Buffer restore alone is a consolation prize**, not a complete solution
- Overselling ("session restore") will damage trust the first time `npm run watch` is dead after reload
- Honest framing is mandatory: *"Your scrollback survives Ctrl+R. Your running process does not."* *[Verified — PLAN.md §5.3 oracle revision]*

### Implementation tiers

#### Tier A — Buffer Restore Visual-Only (mandatory baseline)

| Item | Notes |
|---|---|
| Snapshot strategy | Last N lines of scrollback (cap ~500KB) + cursor position + cwd, serialized to `workspaceState` |
| Trigger | `onWillDispose` + incremental delta (NOT 5s polling — see Engineering reasoning below) |
| Restore strategy | On webview init, paint snapshot as historical content before new PTY's first byte; dim divider line `─── reattached ───` |
| Eviction | Snapshots older than 24h dropped; per-workspace cap 10MB total |
| Honest framing | Command palette entry, README, and first-use notification all state explicitly "process not revived" |
| Effort | **300-500 LOC, ~1 week** *[Verified — PLAN.md §5.3]* |

**Engineering reasoning correction to PLAN.md §5.3:** The original plan specifies "serialized to `workspaceState` every 5s". 5s polling is wasteful for idle terminals and potentially expensive for heavy-output terminals (e.g. `cat huge.log` triggers serialization while paint pipeline is hot). Recommend event-driven snapshot: `onWillDispose` + every 30s if dirty + on cwd change.

#### Tier B — Optional tmux/screen wrap (deferred, opt-in)

Original PLAN.md explicitly skips tmux wrap (§11). Tao đã challenge this lần trước:

| Skip rationale (PLAN.md §11) | Counter-argument |
|---|---|
| *"Tmux/screen not always installed"* | True on Windows; on macOS/Linux most power users have it |
| *"Wraps add ~200ms launch latency"* | **Unverified** — tmux startup overhead is typically <50ms on modern systems. Needs benchmark before accepting as fact. *[Engineering reasoning]* |
| *"Conflicts with native VS Code persistence settings"* | Valid — but solvable via per-profile opt-in setting |
| *"ROI vs simple buffer restore is low"* | Disagree — bpasero quote shows process revive is the actual want |

**Recommendation:** Ship Tier A first. After 30-60 days, monitor user complaints about "npm run watch still dies". If signal is strong, add `anywhere.persistence.useTmuxIfAvailable` setting (per-profile opt-in, default false). This is the honest middle ground.

### Microsoft absorption risk: **Medium-High**

VS Code core already has persistent sessions. Buffer restore is the natural next step. *[Engineering reasoning — see PLAN.md §1 cautionary tale of formulahendry.terminal being absorbed]*

**Mitigation:** Ship within next 1-2 monthly releases. If Microsoft ships first, AT's Tier B (tmux wrap) becomes the differentiator.

### References

- `microsoft/vscode` issues: `#44302`, `#128001`, `#131634`, `#123518`
- `EthanSK.restore-terminals` (108k installs), `fabiospampinato.vscode-terminals` (74k), Terminal Keeper (222k)
- PLAN.md §1.3, §5.3, §11 (tmux skip), §13.B mapping

---

## #2 — Workspace Auto-launch Templates

**Evidence weight:** 🔴🔴🔴🔴 (high, with clean differentiation angle)

### Why this is #2

| Signal | Value |
|---|---|
| Adjacent extension installs | Restore Terminals (108k) + Terminals Manager (74k) prove workspace-template demand |
| Job-to-be-done frequency | Both research docs flag "Phiên & khởi tạo" cluster as second-largest after persistence |
| User pattern | Open project → expect `server/client/test/watch` terminals pre-staged |
| User quote (Reddit, translated) | *"Tôi muốn mở nhiều terminal theo project kiểu server/client/test/watch, autorun theo workspace, restore lại nguyên layout khi mở dự án."* *[Verified — custom-gpt.md §"Web dev" persona]* |

### Critical execution: trust-first design

**Oracle disagreement resolved in PLAN.md §6:** Manual-trigger + preview, NOT auto-spawn. *[Verified — PLAN.md §3 oracle disagreement #2]*

After May 2026 VS Code extension supply-chain incidents, repo-controlled commands that auto-execute will be perceived as a security smell. This **changes the competitive positioning**:

- Restore Terminals: auto-spawns on workspace open (current trust risk)
- Terminals Manager: power-user JSONC config, manual trigger
- **AT opportunity:** Beautiful preview UX + manual confirm + trusted-mode gate

This is the **clean differentiation angle** — Restore Terminals has 108k installs but is now stuck on a trust-risky default. AT can capture the trust-conscious segment.

### Implementation

#### 2.1 Schema and config file

| Item | Notes |
|---|---|
| File | `.vscode/anywhere-terminals.json` (workspace-scoped, git-trackable) |
| Schema | Named terminals + split layout + cwd (relative to workspace) + optional `startupCommands[]` + location preference (sidebar/panel/editor) |
| Design lesson | Study Terminals Manager + Terminal Keeper JSONC for what works; deliberately simpler |

#### 2.2 Manual restore UX (trust-first)

| Item | Notes |
|---|---|
| Trigger | Command `AnyWhere Terminal: Launch Workspace Layout` (no default keybinding) |
| Discovery | When workspace with config opens first time, show one-time toast: *"This workspace has an AnyWhere Terminal layout. Launch it?"* with `Launch` / `Dismiss` / `Don't show again`. **NOT** auto-spawn. |
| Preview | Modal shows full layout tree + every startup command verbatim. User clicks `Run All`, `Run Without Startup Commands`, or `Cancel`. |
| Trusted-mode gate | `startupCommands` disabled in Restricted Mode. Layout-only restore allowed. |

#### 2.3 Save current layout as template

| Item | Notes |
|---|---|
| Command | `AnyWhere Terminal: Save Current Layout to Workspace` — dumps current tabs + splits + cwds (not commands) to `.vscode/anywhere-terminals.json` for the user to edit/commit |

### Effort estimate

**600-1000 LOC, ~3 weeks.** *[Verified — PLAN.md §6]*

### Microsoft absorption risk: **Low**

Microsoft unlikely to ship workspace-level JSON config — this is power-user niche. VS Code core philosophy avoids workspace config sprawl. *[Engineering reasoning]*

This makes Phase 2 the **safest medium-term investment** — high demand, low absorption risk.

### References

- `EthanSK.restore-terminals` (108k installs), Terminal Keeper (222k), Terminals Manager (74k)
- `custom-gpt.md` cite `turn21view4`, `turn23view0`
- PLAN.md §6, §13.B mapping

---

## #3 — Command Blocks (Warp-style)

**Evidence weight:** 🔴🔴🔴⚪⚪ (high demand BUT high technical risk)

### Why this is #3 (not #1 despite hype)

| Signal | Value |
|---|---|
| Bidirectional demand | Warp users want it in VS Code (`warpdotdev/Warp #3560`); VS Code users want Warp UX (Reddit cluster) |
| User quote | *"After 20 years of programming, I still find it hard to copy a command's output."* (Show HN: Warp, Hacker News) |
| Reddit cluster (translated) | *"Tôi thích autocomplete, tính năng AI và cảm giác gõ của Warp, nhưng việc phải mở nó như một cửa sổ riêng thì khá phiền"* *[Verified — custom-gpt.md `turn6view0`]* |
| Strategic positioning | "Largest possible UX differentiator" *[Verified — PLAN.md §8]* |

**Why not #1:** Technical risk significantly higher than #1 and #2. Effort estimate 5-6 weeks with non-trivial failure modes.

### Critical technical risk (raised in evaluation session)

**DOM overlay alignment with xterm.js rows is unverified.** *[Engineering reasoning]*

PLAN.md §8.1 specifies: *"Render block borders + actions as DOM overlay aligned to xterm's row coordinates using linkifier-style positioning"*. The problems:

1. xterm.js reflows on terminal resize → row coordinates shift
2. Fast streaming output triggers scroll → overlay must reposition at 60fps
3. Buffer trimming (scrollback limit) invalidates row indices
4. WebGL renderer (AT uses) has sub-pixel rendering differences vs canvas

**The reason Warp, Wave, and Ghostty all built renderers from scratch** instead of wrapping xterm.js is precisely this alignment problem.

**Mandatory prototype gate** (added to PLAN.md recommendation):

> Before committing 5-6 weeks for Phase 4, dedicate 3-5 days to a prototype that stress-tests DOM overlay alignment under:
> - Fast scrolling (>1000 lines/sec output)
> - Resize during active output
> - Reflow on font-size change
> - Long-running terminal (>10k scrollback lines)
>
> Go/no-go decision based on prototype. If prototype fails alignment, downgrade scope to "render block UI for last N blocks only" (Warp's active-block concept).

### Implementation (gated on Phase 3 shell integration detection)

**Hard gating from PLAN.md §8:** Only enabled for sessions where Phase 3 marks `shellIntegration: active`. Inactive sessions show vanilla xterm + hint banner.

This gating is **critical** — without it, users with broken shell integration (oh-my-zsh custom prompts, manually-installed zsh, fish with non-standard config) see half-empty feature and uninstall.

#### 4.1 Block UI overlay

| Item | Notes |
|---|---|
| Renderer | Do **not** replace xterm.js. Render as DOM overlay using `linkifier`-style positioning (subject to prototype validation) |
| Per-block actions | Collapse / expand, copy-output-only, copy-command-only, rerun-command, mark-as-failed (visual) |
| Navigation | `Cmd+Up` / `Cmd+Down` jumps to previous/next prompt; `Cmd+Shift+Up/Down` selects across blocks |
| Exit code badge | Green check / red X / yellow signal-killed icon next to each finished block |

#### 4.2 Free-rider features (enabled by block instrumentation)

| Feature | Notes |
|---|---|
| Copy Last Command Output | Right-click in terminal background |
| Finish Notification | If command runs >10s AND window unfocused at exit, show notification with exit code |
| Jump to Last Failed | Command palette entry |

#### 4.3 Honest fallback (mandatory)

When `shellIntegration: inactive`:
- No block borders rendered (vanilla xterm)
- Dismissible banner at top: *"Enable shell integration to see command blocks. [Install for zsh] [Don't show again]"*
- Block-derived features visibly disabled in menus (not hidden)

**Never simulate using prompt-detection heuristics.** False-positive rate on `❯ ` or `$ ` prompts is too high; trust damage from miscut blocks is severe. *[Verified — PLAN.md §7.3]*

### Effort estimate

**1500-2500 LOC, 5-6 weeks** *[Verified — PLAN.md §8]*

**PLUS** 3-5 days prototype gate before Phase 3 commit.

**PLUS** Phase 3 prerequisite: 800-1200 LOC, 3-4 weeks (shell integration instrumentation).

**Total realistic envelope:** 9-11 weeks including prerequisites and prototype.

### Microsoft absorption risk: **Medium**

VS Code core already has Sticky Scroll for terminal. Command blocks UI is a natural extension. *[Engineering reasoning]*

**Counterweight:** UI cost for Microsoft to ship this well is high; their priority queue is consumed by AI features. Likely 6-12 month window before they ship.

### References

- `warpdotdev/Warp #3560` (bidirectional demand)
- Hacker News "Show HN: Warp"
- VS Code shell integration docs (OSC 633 protocol)
- PLAN.md §7 (Phase 3 prerequisite), §8 (Phase 4)

---

## Summary Matrix

| # | Feature | Effort | Demand | Tech Risk | MS Absorption Risk |
|---|---|---|---|---|---|
| 1 | Session / Buffer Restore | 1 week (Tier A) + optional Tier B | 🔴🔴🔴🔴🔴 | Low | Medium-High |
| 2 | Workspace Auto-launch Templates | 3 weeks | 🔴🔴🔴🔴 | Low | Low |
| 3 | Command Blocks (Warp-style) | 9-11 weeks (incl. Phase 3 + prototype) | 🔴🔴🔴⚪⚪ | **High** | Medium |

---

## Strategic recommendation

**Sequence by risk-adjusted ROI:**

1. **Ship Feature #1 Tier A first (1 week)** — high demand, low risk, validates AT's persistence story before harder features
2. **Ship Feature #2 next (3 weeks)** — high demand, low absorption risk, leverages Phase 1 state machinery
3. **Prototype Feature #3 BEFORE committing** — 3-5 days to validate DOM overlay viability. If fail, defer Phase 4 and pivot to UX polish (Phase 5 history autosuggest)

**Total realistic timeline to ship Features #1 + #2:** 4-5 weeks. This delivers ~80% of high-demand user value before touching the technically risky Feature #3.

---

## Caveats

- **Install counts are spot values for 2026-05-24** and drift; not normalized for active usage *[Verified — PLAN.md §13]*
- **GitHub reaction counts could not be verified individually** in source research because GitHub blocks scrapers *[Verified — PLAN.md §13]*
- **Tmux startup latency claim ("~200ms")** in PLAN.md §11 is unverified — needs benchmark before accepting as design constraint *[Engineering reasoning]*
- **Microsoft absorption risk estimates are engineering judgment**, not from quantitative analysis. Monitor VS Code release notes quarterly.
- **Phase 4 DOM overlay viability is unproven** — prototype mandatory before commit

---

## Cross-references

- Full strategic context: `PLAN.md`
- Quick-win execution: `PLAN-quick-wins.md`
- Source research: `docs/external-research/custom-claude.md`, `docs/external-research/custom-gpt.md`