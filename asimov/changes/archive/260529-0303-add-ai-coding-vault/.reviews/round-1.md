# Review: add-ai-coding-vault (Round 1)

- **Date:** 2026-05-28
- **Reviewable lines:** ~2924 added across 37 files (28 source + tests/fixtures)
- **Agents spawned:** data-security, logic, contracts, frontend (all 4)
- **Verdict:** WARN → all findings addressed; 0 BLOCK remaining
- **Counts:** BLOCK 0 · WARN 5 (all accepted+fixed) · SUGGEST 1 (deferred)

## Findings

### [L1] Synchronous reader throw could bypass Promise.allSettled — `src/vault/VaultService.ts:42`
- Agent: logic · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: readers were invoked while building the array literal; a *synchronous* throw (only possible from a non-async injected reader) would abort aggregation before `allSettled` ran.
- Fix: `invokeReader(read) = Promise.resolve().then(read)` wraps each call; opencode fork probe wrapped in try/catch at the service boundary.
- Triage: accepted — defensive robustness; current async readers can't sync-throw, but the wrap future-proofs custom readers. Verified: 1601 tests pass.

### [L2] Early-break readline loops didn't destroy the file stream — `src/vault/readers/claudeReader.ts:127`, `src/vault/readers/codexReader.ts:122`
- Agent: logic · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: both readers stop early but only `rl.close()`'d; `readline.close()` does not destroy the underlying `createReadStream`, risking a lingering fd on large transcripts.
- Fix: keep the stream handle, `stream.destroy()` in `finally`.
- Triage: accepted — correct fd hygiene reinforcing the bounded-read intent.

### [L3] Restored vault panel rendered empty after reload — `src/webview/main.ts:675`
- Agent: logic · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: on reload with `auxiliaryPanelActive === "vault"`, the panel mounted but only the `openVault` command requested sessions, so the restored vault stayed empty.
- Fix: after `activate(persistedActive, {persist:false})`, call `vaultPanel.requestRefresh()` when active === "vault".
- Triage: accepted — real UX correctness gap.

### [F1] Untrusted-shaped agent id interpolated into a CSS class — `src/webview/vault/VaultPanel.ts:164`
- Agent: frontend · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: `badge.className = \`vault-badge vault-badge--${entry.agent}\``. (Note: `entry.agent` is reader-set to a literal "claude"/"codex"/"opencode", so not actually file-derived — the reviewer's "untrusted" premise is incorrect.) No script-exec risk; at most extra class tokens.
- Fix: `classList.add("vault-badge")` + add the modifier only when `entry.agent` matches `/^[a-z0-9-]+$/i` (classList.add rejects whitespace).
- Triage: accepted as cheap defense-in-depth — makes the invariant local instead of relying on reader discipline.

### [F2] Persisted panel id not validated before activate — `src/webview/main.ts:673`
- Agent: frontend · Severity: WARN · Confidence: HIGH · Status: accepted · **fixed**
- Evidence: `getState().auxiliaryPanelActive` reads raw persisted JSON; a corrupt value would no-op `activate()`. (Impact was over-stated — `activate` always hides others, so "both visible" can't occur; an unknown id simply falls back to the HTML default of file-tree-visible.)
- Fix: coerce to `=== "vault" ? "vault" : "file-tree"` so the restore always targets a registered panel.
- Triage: accepted — removes ambiguity for corrupt state.

### [F3] Vault rows not arrow-key navigable — `src/webview/vault/vaultPanel.css:168`
- Agent: frontend · Severity: SUGGEST · Confidence: MEDIUM · Status: rejected (deferred) · **not fixed**
- Evidence: actions are `opacity:0` until `:hover`/`:focus-within`; rows lack `tabindex`.
- Triage: rejected for MVP — the resume/fork controls are real `<button>`s in the natural tab order, and `:focus-within` reveals them on Tab focus, so keyboard access already works. Arrow-key row navigation is a non-blocking enhancement (follow-up).

## Clean reviews

- **data-security:** No findings. Verified end-to-end (through `node-pty` execvp): WAL-safe read-only SQLite, argv-based injection-safe launch (hostile session id stays one inert arg), metadata-only privacy (bounded ≤120 title, no persistence/egress), Claude 8-var auth allowlist only, static SQL.
- **contracts:** No findings. IPC unions consistent + routed, `createSession` env extension non-breaking, registry matches spec, package.json command contributions mirror the existing `exportPick` pattern and are all registered.

## Session IDs
- data-security: a8525b2dcfaa621d8
- logic: ac5081538f811210a
- contracts: a0ae196bdb0195691
- frontend: aab55e9178fa6e870
