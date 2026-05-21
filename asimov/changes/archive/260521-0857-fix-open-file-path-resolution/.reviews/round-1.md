# Review Round 1 — fix-open-file-path-resolution

**Date**: 2026-05-21
**Reviewable lines**: ~380 (under 800)
**Agents spawned**: data-security, logic, frontend
**Agents skipped**: contracts (no IPC/API contract changes)
**Verdict**: WARN (0 BLOCK, 4 WARN, 4 SUGGEST)

## Findings

### [W1] file:// URI guard omits authority check — UNC SMB egress on Windows
- **Severity**: WARN (security)
- **Confidence**: MEDIUM
- **Priority**: P2
- **Agent**: data-security
- **File**: `src/providers/pathPreprocess.ts:22`
- **Evidence**: Guard is `uri.scheme === "file" && uri.query === "" && uri.fragment === "" && uri.fsPath`. No `authority` check. `file://attacker.example.com/share/x.md` parses on Windows to a UNC path `\\attacker.example.com\share\x.md`. `fs.stat` on it triggers SMB connection BEFORE the out-of-scope modal fires.
- **Impact**: A hostile process writing clickable tokens to the terminal can probe network egress and potentially leak NTLM creds on click — classic UNC attack pattern. The modal does fire eventually, but the network handshake already happened.
- **Suggested fix**: Add `uri.authority === ""` to the guard.
- **Status**: accepted
- **Triage**: ACCEPT. Real attack vector even at MEDIUM confidence — one-line fix.

### [W2] file:// fsPath not screened for NUL bytes
- **Severity**: SUGGEST (security; combined with [W1] fix)
- **Confidence**: MEDIUM
- **Priority**: P4
- **Agent**: data-security
- **File**: `src/providers/pathPreprocess.ts:22`
- **Evidence**: `file:///abs/x%00.md` decodes to `/abs/x\x00.md`. On most Node versions `fs.stat` throws on embedded NUL, but logged path mismatches actually-stat'd path causes confusing diagnostics.
- **Status**: accepted
- **Triage**: ACCEPT. Folded into the same guard expansion as [W1].

### [W3] findFiles glob uses `msg.path` instead of `transformedPath` — bogus glob for malformed file://
- **Severity**: WARN
- **Confidence**: HIGH (chair upgrade after re-trace)
- **Priority**: P3
- **Agent**: logic
- **File**: `src/providers/openFileLink.ts:~395`
- **Evidence**: For a malformed `file://garbage`, `buildCandidates` returns empty candidates with `kind: passthrough-malformed`, but the findFiles block still enters because `msg.path = "file://garbage"` fails neither `isAbsolutePath` nor `hasTraversal`. The bogus glob `**/file:[/][/]garbage` is sent to `vscode.workspace.findFiles`. Test coverage masks it (default mock returns `[]`, falls through to "File not found").
- **Impact**: Wastes a findFiles call on a malformed input; could surface as a workspace-search anomaly. Currently no user-visible bug, but the two code sites are out of sync.
- **Suggested fix**: After `buildCandidates`, if it returned 0 candidates due to `passthrough-malformed`, skip findFiles entirely. Alternative: thread `transformedPath` into the findFiles gate and use `isAbsolutePath(transformedPath)`.
- **Status**: accepted
- **Triage**: ACCEPT. The malformed `file://` short-circuit should be complete — currently leaks a stray findFiles invocation.

### [W4] Lazy SUFFIXED body can match colon-rich chains
- **Severity**: WARN (UX)
- **Confidence**: MEDIUM
- **Priority**: P4
- **Agent**: frontend
- **File**: `src/webview/links/filePathParser.ts` (`buildSuffixedRegex`)
- **Evidence**: With `:` now in body, lazy match on `error C:\Users\foo:bar:baz:42` captures `C:\Users\foo:bar:baz` as path (multiple colons consumed before suffix bites). `looksLikeFile` accepts it (has `\`). Underline appears; click produces "File not found".
- **Impact**: UX annoyance on pathological terminal output. Not a correctness issue.
- **Status**: rejected
- **Triage**: REBUT. The frontend agent themselves note "vanishingly rare" tradeoff. The proposed sanity check (colon count limit) is fragile and would break legitimate paths containing colons (rare but possible). Accept the noise; resolver-side "File not found" toast is the safety net.

### [S1] endsWithPath leading-/ anchor latent — unreachable in current call graph
- **Severity**: SUGGEST
- **Confidence**: HIGH
- **Priority**: P3
- **Agent**: logic
- **File**: `src/providers/openFileLink.ts:~140` (`endsWithPath`)
- **Evidence**: If `clickedPath` starts with `/`, the anchor `a.endsWith(\`/${c}\`)` becomes `//...` which never matches. Confirmed unreachable: absolute paths short-circuit in `buildCandidates` before reaching the basename fallback.
- **Status**: rejected
- **Triage**: REBUT. Latent and unreachable. Adding a defensive guard would be dead code today. Existing call graph correctness is enforced by tests.

### [S2] resolveCwdRelative with empty link returns `[cwd]`
- **Severity**: SUGGEST
- **Confidence**: MEDIUM
- **Priority**: P4
- **Agent**: logic
- **File**: `src/providers/resolveCwdRelative.ts:35`
- **Evidence**: `link=""` → `linkParts=[]` → `length <= 1` → returns `[cwd]`. Caller `openFileLink` guards `msg.path.length === 0` at top of handler, so unreachable through normal callers.
- **Status**: rejected
- **Triage**: REBUT. Caller-side guard exists; exported function is a pure helper used only by `buildCandidates`. Defensive guard would be dead code.

### [S3] stat runs before isInside check — existence/permission oracle via console.warn trace
- **Severity**: SUGGEST
- **Confidence**: MEDIUM
- **Priority**: P3
- **Agent**: data-security
- **File**: `src/providers/openFileLink.ts:336-363` (stat loop)
- **Evidence**: For absolute clicks, every candidate is stat'd before the out-of-scope modal fires. Result is surfaced via `console.warn` trace in DevTools. Requires user click; existing behavior, not introduced by this change.
- **Status**: rejected
- **Triage**: REBUT. Pre-existing behavior. Reordering the modal-before-stat sequence is an architectural change with its own UX implications (would gate clicks on user confirmation for ANY out-of-scope absolute path before we even know if the file exists). Defer to a separate change.

### [S4] identifier@version heuristic rejects patch-file names
- **Severity**: SUGGEST
- **Confidence**: MEDIUM
- **Priority**: P5
- **Agent**: frontend
- **File**: `src/webview/links/filePathParser.ts` (`looksLikeFile`)
- **Evidence**: `/^[A-Za-z_][A-Za-z0-9_-]*@\d/` rejects `react@18.2.0.patch` before the `[/\\]/` early-return. Real patch files referenced in terminal output won't get clickable links.
- **Suggested fix**: Anchor the rejection to end-of-string or whitespace boundary so trailing `.patch`/`.diff` survives.
- **Status**: accepted
- **Triage**: ACCEPT. Small, targeted fix; preserves legitimate path detection.

## Accepted fixes for round-2 (after re-verify)

1. **W1 + W2 (combined)**: Strengthen `expandTildeAndFileUri` file:// guard with `authority === ""` and NUL-byte check.
2. **W3**: Make `openFileLink` skip the findFiles block when `buildCandidates` returned empty due to malformed input.
3. **S4**: Anchor the `@version` heuristic to end-of-string so patch files survive.

## Session IDs (for re-review)

- data-security: ab713ab7b31d0ffdc (chair note: agentId from logic — see SendMessage below)
- logic: ab713ab7b31d0ffdc
- frontend: aa0cc431a791a628e

Actually, per the agent output records:
- logic: `ab713ab7b31d0ffdc`
- data-security: `a7ba516be05a17b37`
- frontend: `aa0cc431a791a628e`
