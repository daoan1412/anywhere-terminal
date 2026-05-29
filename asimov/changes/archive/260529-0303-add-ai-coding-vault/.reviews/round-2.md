# Review: add-ai-coding-vault (Round 2)

- **Date:** 2026-05-29
- **Reviewable lines:** ~3072 added across src/ + package.json (post round-1 placement pivot)
- **Agents spawned:** data-security, logic, contracts, frontend (all 4) + asm-oracle (independent)
- **Verdict:** BLOCK → 1 blocking issue (pane-select sync race), confirmed independently by logic + oracle
- **Counts:** BLOCK 1 · WARN 3 (accepted) · SUGGEST/deferred 4
- **Scope note:** Round 1 vetted the vault *core* (readers, sqlite, launch) clean. This round targets the placement/freshness/folder-filter work added AFTER round 1 (aux-region collapsible section, `onActivePaneChange`/`switchTab` refresh, "This folder only", `AuxiliaryPanelManager` deletion).

## Findings

### [B1] Pane-click vault sync suppressed by focusin/mousedown race — `src/webview/main.ts:879`, `src/webview/split/SplitTreeRenderer.ts:112`
- Agent: logic + oracle (independent) · Severity: BLOCK · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: The `focusin` handler (`main.ts:871-886`) runs during xterm's own target `mousedown` (xterm focuses its textarea, which dispatches `focusin` synchronously) and sets `store.tabActivePaneIds` at `main.ts:879-882` WITHOUT calling `syncVaultToActivePane()`. The leaf `mousedown` listener then bubbles up, sees `currentActive === sessionId` (`SplitTreeRenderer.ts:112-115`), and early-returns before `onActivePaneChange()` at line 130. Net: a plain click into another split pane leaves the vault's `contextCwd` scoped to the previous pane and never re-reads — the user-requested "refresh/re-scope vault on pane select" silently does not fire on a click.
- Fix: in the `focusin` handler's leaf-driven active-pane-change branch (after `store.persist()`), call `syncVaultToActivePane()`. Symmetric with the leaf-mousedown path: whichever handler wins the race performs exactly one sync (the loser's guard makes it a no-op), so no double-fetch.
- Triage: accepted — real functional regression in the feature the user explicitly requested. This is the cross-method temporal coupling that code-review-alone is prone to miss (it depends on runtime event ordering).

### [W1] `isWithin` under-matches root / trailing-separator cwd — `src/webview/vault/VaultPanel.ts:31`
- Agent: logic + oracle · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: `isWithin(child, parent)` did `child === parent || child.startsWith(parent + "/")`. Correct for normal subdirs and avoids the sibling-prefix trap (`/a/b` vs `/a/bc`), but under-matches when `parent` is a filesystem root (`/`) or carries a trailing separator (`/a/b/`): a valid child like `/a` (root) or `/a/b/c` (trailing-slash parent) is excluded.
- Fix: strip trailing separators from both paths before comparison; treat a parent that normalizes to empty (a root) as containing every absolute path.
- Triage: accepted — `cwd` now drives the new folder filter, so boundary correctness matters. Case-insensitive (APFS) and symlink canonicalization deferred (would need host-side `realpath`; noted as SUGGEST).

### [W2] Header count badge shows total while the list is folder/query filtered — `src/webview/vault/VaultPanel.ts:255`
- Agent: frontend · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: `countEl.textContent` was set from `entries.length` (total) in `render()`, but `renderList()` shows only `matchesFolder && matchesQuery` rows. With "This folder only" on (or a search active), the badge over-reports (e.g. badge "42" above a 3-row list).
- Fix: set the badge from the filtered `visible.length` inside `renderList()` (so it tracks every filter/search/cwd change); drop the stale assignment in `render()`.
- Triage: accepted — cheap; the discrepancy only became visible once the folder filter shipped.

### [W3] Vault not re-read when the VS Code view becomes visible — `src/webview/main.ts:352`
- Agent: oracle · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: design D11 / spec state the vault "re-reads its list whenever it becomes visible". `onViewShow` only called `resizeCoordinator.onViewShow()` — hiding then re-showing the sidebar/panel left an already-expanded vault showing stale metadata until a pane/tab change.
- Fix: call `refreshVaultIfOpen()` in `onViewShow` (guarded — no fetch when collapsed). The active pane/cwd is unchanged on reshow, so a re-read (not a re-scope) is sufficient.
- Triage: accepted — one-liner, directly fulfils the stated "refresh on becoming visible" contract.

## Rebutted / deferred (not fixed)

### [L3-rebut] OpenCode `no-sqlite3` returns 0 entries / 0 unreadable — `src/vault/readers/opencodeReader.ts:95`
- Agent: logic · Severity: WARN→**rebutted** · Status: rejected
- Rebuttal: AT is macOS-only (proposal Risk Level; design D3). macOS ships `/usr/bin/sqlite3` (≥3.37, `-json`-capable), which resolves even under the minimal Dock-launch PATH (`/usr/bin` is always present). So `no-sqlite3` is effectively unreachable on the supported platform; treating it as graceful degrade-to-empty (D3) is intentional. Surfacing it as "N could not be read" would emit a false-alarm notice on genuinely-empty/unsupported setups — worse UX on the degrade path. No fix.

### [F2-rebut] Both-collapsed region-hug needs `file-tree--root-collapsed` (absent in no-workspace) — `src/webview/fileTree/fileTreePanel.css:714`
- Agent: frontend · Severity: WARN→**rebutted** · Status: rejected
- Rebuttal: With no workspace, the file tree renders its empty-state and cannot be root-collapsed (no root row/chevron). The file-tree section filling the sized region is pre-existing behavior (the panel always occupied the region pre-vault). The `:has()` hug rule correctly targets the genuine *both-collapsed* case. Not a regression introduced by this change. No fix.

### [F3-defer] Vault rows lack row-level keyboard affordance — `src/webview/vault/vaultPanel.css:225`
- Agent: frontend · Severity: SUGGEST · Status: deferred (carries round-1 [F3])
- Rationale: Resume/Fork are real `<button>`s in the natural tab order; `:focus-within` reveals them on Tab. Arrow-key row navigation is a non-blocking MVP follow-up. Same disposition as round-1 [F3].

### [O3-defer] `handleVaultLaunch` doesn't re-check webview liveness after async resolve — `src/providers/TerminalViewProvider.ts:344`
- Agent: oracle · Severity: WARN→SUGGEST · Status: deferred
- Rationale: Mirrors the existing `createTab` flow (fire-and-forget `safeSendWithRetry` + no post-async liveness guard), which round-1 contracts explicitly accepted. The longer async window (resolve → `list()`) marginally widens an orphan-session edge, but the rollback fix would diverge from the codebase-wide createSession pattern. Defer to a focused follow-up if the pattern is ever hardened globally.

## Clean reviews
- **data-security:** No findings. Re-verified end-to-end on the new launch handler: shell-free argv path (`LaunchBuilder` → `VaultLauncher` → `handleVaultLaunch` → execvp-style node-pty spawn), static SQL only, WAL-safe read-only temp copy always cleaned up in `finally`, Claude-only 8-var auth allowlist (`configDir` sourced from host env not transcript), bounded ≤120-char newline-stripped preview, zero `fetch`/`writeFile`/`workspaceState` in `src/vault/`.
- **contracts:** No findings. All 5 new IPC types are union members + routed + handled (optional host→webview handlers safe — main.ts supplies both); registry matches spec (resume/fork templates, opencode `forkMinVersion 1.14.50`, 8-var allowlist); package.json command contributions (palette + per-view title + `when:false`) all registered in extension.ts; `vaultCollapsed`/`vaultFolderOnly` optional + backward-compatible.

## Session IDs
- data-security: a06889be0e4ebfc16
- logic: aba35a8a090fc709b
- contracts: ad258c554dde500b7
- frontend: a6ad4f3b7f04ba73b
- oracle: a6efa7169b312aad0
