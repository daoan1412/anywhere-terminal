# Review Round 1 — preview-subagent-popup

Reviewers: asm-review-logic, asm-review-data-security, asm-review-frontend, asm-review-contracts.
Verdict: **0 BLOCK.** 4 WARN + 4 SUGGEST. 4 accepted (fixed), 4 rebutted/deferred.

| # | Sev | File | Finding | Status | Triage |
|---|-----|------|---------|--------|--------|
| 1 | WARN P2 | webview/links/subagentLineParser.ts | Header clipped past the closing `)` (very narrow terminal) → regex returns null → no clickable link | rejected | Out of MVP scope: proposal § Out of scope explicitly defers "hardening the description matcher beyond prefix-match". Relaxing the `)$` anchor to match unclosed `Name(…` would emit false-positive links on ordinary `foo(bar` prose/code/shell lines — a worse regression than a rare missing affordance. The in-scope clipping case (description shortened, `)` still present) is already handled by prefix-match resolution (D5). Header `)` adjacency is also load-bearing for rejecting the `Done (…)` trailer. |
| 2 | WARN P3 | session/resolveClaudeSession.ts:`pickNewest` | Equal `<sessionId>.jsonl` mtime → keeps first candidate (nondeterministic readdir order) | accepted | Fixed: added stable secondary key (lexical `sessionId`). |
| 3 | WARN P3 | vault/readers/subagentLookup.ts:`pickNewestByMtime` | Equal mtime → keeps first candidate (directory order) | accepted | Fixed: added stable secondary key (lexical `stem`). |
| 4 | WARN P3 | webview/main.ts:`switchTab` | Keyboard-driven tab switch leaves the body-mounted popup overlaying the new tab (mouse switch dismisses via outside-click; keys don't) | accepted | Fixed: `factory.disposeSubagentPopup()` at the top of `switchTab`. |
| 5 | WARN P3 | types/messages.ts:`SubagentPreviewResponseMessage` | JSDoc says "EXACTLY one of detail/error" but type allowed both/neither | accepted | Fixed: converted to a strict XOR discriminated union mirroring `VaultSessionDetailResponseMessage`. Host producers already send exactly one → compiles clean. |
| 6 | SUGGEST | vault/readers/claudeChildren.ts `readSubagentMeta` / claudeRecords.ts `readFirstUserRecord` | Unbounded reads (no size cap) reached once per stub on each click | rejected | Out of this change's scope: pre-existing readers, NOT modified here; files live under the user's own `~/.claude` (attacker-uncontrolled, not webview data) — robustness, not security. Reviewer agreed it is not exploitable. |
| 7 | SUGGEST | vault/readers/subagentLookup.ts | `description` (webview) length unbounded before `startsWith` | rejected | Harmless per reviewer (short on-disk descriptions make `startsWith` return fast; never path-used). Not worth host-edge clamp code. |
| 8 | SUGGEST | webview/links/SubagentPreviewPopup.ts:`position` | First `position()` reads zero-dim `getBoundingClientRect` → possible 1-frame mis-position of the loading box (corrected on `setContent`) | rejected | Fallback dims (560×280) already produce a usable position; `setContent` re-clamps. Negligible; not worth added complexity. |

Re-verify after fixes: `pnpm run check-types` clean; `pnpm run test:unit` 2006 pass / 0 fail.
No BLOCK findings → exit review at round 1.
