# Review: auto-reveal-active-file (Round 1)

**Date**: 2026-05-23
**Reviewable lines**: ~491 (production code only; excludes 349 LOC tests, 149 LOC pre-existing CSS, 19 LOC lockfile)
**Agents spawned**: contracts (`abd4de1a67b3ff4c5`), logic (`a33256db1f5395374`)
**Agents skipped**: data-security (no DB/auth/secrets touched), frontend (no React/JSX — vanilla TS webview is logic-shaped)
**Verdict**: **WARN**
**Counts**: 0 BLOCK · 3 WARN · 0 SUGGEST (W3 added post-review from user manual smoke)

---

## Findings

### [W1] `autoRevealExclude` schema rejects the object shape the reader accepts

- **Severity**: WARN
- **Confidence**: HIGH
- **Priority**: P2
- **Agent**: contracts (`abd4de1a67b3ff4c5`)
- **File**: `package.json:128`
- **Evidence**: `package.json` declares `additionalProperties: { "type": "boolean" }` (line 128-132), but `FileTreeSettingsReader.normalizeExclude` (line 65-73) accepts object values and warn-keeps them. The change spec explicitly says `when`-condition object values "may be present in the user's config but are NOT honored in v1 (treated as plain `true`)."
- **Impact**: Users copying VS Code-style `explorer.autoRevealExclude` entries with `{ "when": "..." }` will see settings-schema validation errors or poor Settings-UI behavior even though the runtime reader accepts that shape. The user-facing contract (schema) lies relative to the runtime contract (reader).
- **Suggested fix**: Widen the schema to match runtime — `"additionalProperties": { "oneOf": [{ "type": "boolean" }, { "type": "object" }] }` — OR remove object-shape acceptance from the reader (drop the warn-log branch). Recommended: widen schema, since the design's stated intent is forward-compat with VS Code's eventual `when`-condition support.
- **Status**: accepted + fixed
- **Triage**: accepted, fix applied this round

### [W3] Auto-revealed row lands at viewport bottom instead of center

- **Severity**: WARN
- **Confidence**: HIGH
- **Priority**: P2
- **Agent**: chair (user-reported during manual smoke)
- **File**: `src/webview/fileTree/Tree.ts:623` and `src/webview/fileTree/FileTreePanel.ts:269`
- **Evidence**: `Tree.revealElement(element)` calls vendored `list.reveal(index)` with NO `relativeTop` arg. Per `src/vendor/vscode/base/browser/ui/list/listWidget.ts:1971-1994`, the no-`relativeTop` branch uses a minimum-scroll algorithm that lands the row at the TOP or BOTTOM edge of the viewport — never centers. VSCode's own explorer auto-reveal calls `tree.reveal(item, 0.5)` to center. Visible in user screenshot — the selected file (`sGOLD.sol`) appears at the absolute bottom of the panel, hugging the edge.
- **Impact**: Every auto-reveal that requires scrolling drops the target at the viewport edge, hiding sibling context and forcing the user to scroll manually to see what's around it. This is the #1 UX complaint VSCode's autoReveal has historically had.
- **Suggested fix**: Add optional `relativeTop?: number` arg to `Tree<T>.revealElement(element, relativeTop?)`, pass through to `list.reveal(index, relativeTop)`. In `FileTreePanel.revealPath`, pass `0.5` (center) when `opts?.source === "autoReveal"`. Leave OSC 7 path unchanged to avoid altering existing reveal UX.
- **Status**: accepted + fixed
- **Triage**: accepted, fix applied this round

### [W2] In-root paths whose first component starts with `..` are falsely rejected

- **Severity**: WARN
- **Confidence**: HIGH
- **Priority**: P3
- **Agent**: logic (`a33256db1f5395374`)
- **File**: `src/providers/ActiveFileRevealer.ts:128`
- **Evidence**: The workspace-membership check uses `if (rel.startsWith("..") || path.isAbsolute(rel)) return;`. For `root="/work"` and `fsPath="/work/..foo/file.ts"`, `path.relative` returns `"..foo/file.ts"` — which `startsWith("..")` is true even though the file IS inside the workspace.
- **Impact**: Auto-reveal silently fails for valid in-workspace files/folders whose first path component begins with `..` (uncommon but legal — e.g. `..backup/` or `..tmp/`).
- **Suggested fix**: Reject only the parent-directory sentinel, not any `..`-prefix: `if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;`
- **Status**: accepted + fixed
- **Triage**: accepted, fix applied this round

---

## Verification Question Responses (summary)

| # | Question | Answer |
|---|---|---|
| L1 | Debounce timer race on dispose? | No issue — `dispose()` clears timer + nulls reference; no async interleaving in timer callback. |
| L2 | Panel-hidden gate placement correct? | Correct — `source === 'autoReveal'` gate only triggers for auto-reveal; OSC 7 path still opens panel. |
| L3 | Out-of-root check correctness? | Correct for `/work2/foo` vs `/work/foo`; W2 above is the one false-negative edge. |
| L4 | Settings live-reload race? | true→false during debounce → correctly suppressed (re-read after timer). false→true → scheduling was guarded by listener registration only, not by initial settings state, so it works as intended. |
| L5 | `Disposable.from` semantics? | No issue — VS Code's composite disposable disposes all members regardless of individual throws. |
| C1 | Settings schema valid JSON-Schema? | Yes — `"type": ["boolean", "string"]` + `"enum": [true, false, "focusNoScroll"]` is valid and renders correctly in VS Code's Settings UI. |
| C2 | Backward compat — consumer crashes on optional sessionId? | None found. `FileTreeController.handleReveal` now guards `if (!msg.sessionId) { warn; return; }` before dereferencing. OSC 7 producer in `extension.ts:359` still sets both fields. |
| C3 | Settings normalization completeness? | All schema-declared values handled; defensive fallback to `'reveal'` for unknowns matches default. |
| C4 | Exclude object shape mismatch | See W1. |
| C5 | Default-exclude consistency on explicit empty object? | Correct — explicit `{}` returns `[]` (no fallback to default); fallback only triggers when key is absent. |

---

## Test review (Phase 2.5, inline)

- `src/providers/ActiveFileRevealer.test.ts` (256 LOC, 20 cases) + `src/settings/FileTreeSettingsReader.test.ts` (93 LOC, 11 cases)
- ✅ No `.only` / `.skip` / leftover `console.log`
- ✅ Tests use fake timers correctly; async revealer methods exercised via timer advance
- ✅ Coverage maps to spec scenarios (rapid cycling, mode='none', non-file URI, outside-root, ancestor-exclude, focusNoScroll, custom/notebook editors, diff inputs, config live-reload, invalid pattern, dispose-cleanup, matcher boundary)
- ✅ No PII, secrets, or destructive ops in fixtures
- No findings.

---

## Session IDs (for re-review)

- contracts: `abd4de1a67b3ff4c5`
- logic: `a33256db1f5395374`
- data-security: not-spawned
- frontend: not-spawned
