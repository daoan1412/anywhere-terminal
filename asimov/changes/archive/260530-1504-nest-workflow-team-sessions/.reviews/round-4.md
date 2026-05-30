# Review Round 4 — section 6 redesign + live-fix follow-ups

Scope: the new webview render paths and reader changes added after R1–R3 approval — the
threaded `teammateTurn` node (6_3), the inline `teammateMessage` variant (7_1/D16), the
markdown-lite renderer (7_3/D17), `cleanPromptText`/`hasContent` (7_4/D18), and the CSS
revert (7_2/D15). Dimensions: frontend (render/state), logic, data-security.

## Findings

| ID | Title | Severity | Verdict |
|----|-------|----------|---------|
| R4-1 | `pendingNested` not cleared when a node is collapsed mid-load | WARN | accepted + fixed |
| R4-2 | `.vault-preview-teammate-dir` can overflow on a long peer name | SUGGEST | accepted + fixed |

### R4-1 (WARN) — stale `pendingNested` on collapse-mid-load
`renderTeammateTurn` / `renderSubagentSession` collapse branches emptied the body
(`body.replaceChildren()`) but left the `pendingNested[entryId] → body` entry in place. If the
node was collapsed while its nested detail request was still in flight, the late response would
render into the now-hidden body and leave a stale map entry.
**Fix:** the collapse branch now calls `this.pendingNested.delete(entryId)` — a late response
finds no pending container and is dropped (re-expand re-fetches; cache still serves a response
that landed before collapse). Regression test: "collapsing mid-load drops the pending request".

### R4-2 (SUGGEST) — direction-label overflow
A long peer name in `⟵ <peer>` could push the teammate head layout. **Fix:** `.vault-preview-teammate-dir`
gets `min-width:0; max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`.

## Security spot-check (carried constraints — all intact)
- Transcript/title text → `textContent` only. The new `markdownLite` renderer builds every node
  via `createElement`/`createTextNode` and never touches innerHTML — verified by an XSS test
  (an `<img onerror>` / `<script>` payload renders as inert text). ✅
- Untrusted `color` still sanitized to palette/strict-hex before reaching `--turn-color`. ✅
- `:turn:` segment ids remain view-only (contain `:` → `getEntry` returns null). ✅
- Reader parsing of untrusted transcript stays ReDoS-safe (anchored `[^>]*`/`[^`]+`, indexOf). ✅
- Host still resolves member/segment paths by id under the projects root (containment-checked);
  no webview-supplied path trusted. ✅

## Verdict
**APPROVE — 0 BLOCK, 0 open WARN.** Both findings fixed; full gate green (1827 unit tests).
