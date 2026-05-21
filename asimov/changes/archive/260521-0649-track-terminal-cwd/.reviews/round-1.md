# Review: track-terminal-cwd (Round 1)

**Date:** 2026-05-21T03:25:00Z
**Reviewable lines:** ~275 production (+ 352 test, reviewed inline)
**Agents spawned:** logic (a03eb1955a97ab4d6), data-security (a636ad3e537c34d59), contracts (a9c328d4695b65623)
**Agents skipped:** frontend (no frontend changes)

## Verdict

**BLOCK** — 2 BLOCK findings (1 pass-through invariant violation in PtySession, 1 trust-boundary regression in openFileLink), 3 WARN, 0 SUGGEST kept.

| Severity | Count |
|---|---|
| BLOCK | 2 |
| WARN  | 3 |
| SUGGEST | 0 |

## Findings

### B1 — Sink exception in PtySession.onData skips pass-through forwarding

- **ID:** B1
- **Agent:** logic
- **Severity:** BLOCK
- **Confidence:** HIGH
- **Priority:** P1
- **File:** `src/pty/PtySession.ts:144-148`
- **Status:** pending
- **Triage:** accepted — direct violation of spec "Pass-through guarantee" and design D9.
- **Evidence:** In the `onData` handler, `oscParser.feed(data, this._setCurrentCwd)` runs BEFORE `this._onDataCallback?.(data)`. If the sink (`_setCurrentCwd`) throws, the exception propagates out of `feed`, the `_onDataCallback` line is never reached, and the terminal chunk is silently dropped.
- **Impact:** Terminal renders nothing for any chunk that triggers a throwing sink. Spec mandates byte-identical forwarding regardless of parse outcome.
- **Suggested fix:** Wrap the parser feed in try/catch so forwarding always happens:
  ```ts
  try {
    if (this._setCurrentCwd) {
      this._oscParser.feed(data, this._setCurrentCwd);
    }
  } catch (e) {
    console.error("[AnyWhere Terminal] OSC parser/sink threw:", e);
  }
  this._onDataCallback?.(data);
  ```

### B2 — currentCwd in trust-boundary bases lets shell bypass out-of-workspace confirm

- **ID:** B2
- **Agent:** data-security
- **Severity:** BLOCK
- **Confidence:** HIGH
- **Priority:** P1
- **File:** `src/providers/openFileLink.ts:197-201`
- **Status:** pending
- **Triage:** accepted — currentCwd is shell-controlled via OSC 7/633 (untrusted). Including it in the modal's "bases" lets any process running in the terminal emit `\x1b]7;file:///\x07` to move the trust boundary to `/` and skip the out-of-workspace prompt for any subsequent clicked path.
- **Evidence:** New code path inside the `openFileLink` "out-of-scope confirm" block:
  ```ts
  const current = deps.getCurrentCwd(msg.sessionId);
  if (current) {
    bases.push(current);
  }
  ```
- **Impact:** A malicious postinstall script / curl-pipe-sh / printed-attack-string can emit OSC 7 with `file:///` (or any sensitive parent like `/Users/x/.ssh`), and a subsequent user click on a printed path inside that range opens silently — no modal, no exfil/exec warning.
- **Suggested fix:** Keep `currentCwd` in `buildCandidates` (used only to resolve to a candidate path), but remove it from the trust-boundary `bases` list. The existing `initialCwd` (set by extension at spawn) + `workspaceFolders` (config) remain the only trust roots.

### W1 — findFiles fallback runs even for absolute paths (dead-end glob)

- **ID:** W1
- **Agent:** logic + contracts (deduplicated)
- **Severity:** WARN
- **Confidence:** HIGH
- **Priority:** P2
- **File:** `src/providers/openFileLink.ts:175-186`
- **Status:** pending
- **Triage:** accepted — minor, fixed cheaply.
- **Evidence:** When `msg.path` is an absolute path (`/abs/foo.ts`) that doesn't exist on disk, the candidate at step 1 fails stat, but the code still calls `findFiles("**//abs/foo.ts", …)` which can never match. Wastes a 2-second timeout window per click.
- **Impact:** No correctness issue (still ends with "File not found"), but click latency for missing absolute paths is unnecessarily ~2s.
- **Suggested fix:** Short-circuit before findFiles if `isAbsolutePath(msg.path)`:
  ```ts
  if (resolvedFsPath === undefined && !isAbsolutePath(msg.path)) {
    try { … findFiles … } catch { … }
  }
  ```

### W2 — `..` traversal in clicked path not rejected before findFiles

- **ID:** W2
- **Agent:** data-security
- **Severity:** WARN
- **Confidence:** MEDIUM
- **Priority:** P3
- **File:** `src/providers/openFileLink.ts:178-181`
- **Status:** pending
- **Triage:** accepted as defensive — `vscode.workspace.findFiles` is workspace-constrained by VS Code API, so the attack surface is narrow, but rejecting `..` segments early prevents wasted glob work and removes a latent risk.
- **Evidence:** `escapeGlob` only wraps `*?[]{}` in literal char classes. Slashes (`/`) and `..` segments pass through unescaped. A click on `../etc/passwd` (printed by a hostile shell) produces pattern `**/../etc/passwd`.
- **Impact:** VS Code findFiles is constrained to workspace folders by its API contract, so this is unlikely to escape on its own. Combined with a future regression in workspace bounds, becomes exploitable.
- **Suggested fix:** Before calling findFiles, reject paths containing `..` segments:
  ```ts
  const hasTraversal = msg.path.split(/[\\/]/).some((seg) => seg === "..");
  if (resolvedFsPath === undefined && !isAbsolutePath(msg.path) && !hasTraversal) { … }
  ```

### W3 — OSC 633 raw-path payload not stripped of control characters

- **ID:** W3
- **Agent:** data-security
- **Severity:** WARN
- **Confidence:** MEDIUM
- **Priority:** P4
- **File:** `src/pty/oscParser.ts:152-159, 162-175`
- **Status:** pending
- **Triage:** accepted as defense in depth — OSC 633 is taken literally per spec; control chars are extremely unusual in raw cwd payloads and cheap to reject.
- **Evidence:** `emitIfValid` only checks for `\0`. A path like `/foo\x1bbar` or `/foo\rbar` would pass through and become the session's recorded cwd, potentially mis-displayed in any future UI surface (status bar, logs) or causing path-confusion if other code assumed control-free paths.
- **Impact:** Low — currently only used in `path.join` and the modal. Defense in depth.
- **Suggested fix:** In `emitIfValid`, also reject if `/[\x00-\x1f]/.test(normalized)`.

## Suppressed / Rejected

- **REJECT (suggest)** — Coalesce repeated cwd updates at SessionManager (DS4): no measurable harm in current code paths, premature optimization.
- **REJECT (suggest)** — Debounce / dedupe in-flight findFiles per session (DS5): real cost is negligible (one workspace search per click, max 2s).

## Session IDs

- data-security: a636ad3e537c34d59
- logic: a03eb1955a97ab4d6
- contracts: a9c328d4695b65623
- frontend: not-spawned
