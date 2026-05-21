# Discovery: track-terminal-cwd

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot | Done | finder subagent |
| External Research (OSC 7 wire format + shell landscape) | Done | librarian subagent → `docs/research/20260521-osc7-implementation.md` |
| Memory Recall | Skipped | Prior context fresh from just-archived `add-clickable-file-paths` |

## Key Findings

### 1. PtySession is the right splice point

`src/pty/PtySession.ts:75-131` — node-pty's data is delivered to a callback property setter at line 75; the user callback fires at L130. We can intercept `data` BEFORE invoking the user callback, scan for OSC 7 sequences, update SessionManager, and pass the raw data through unchanged. OutputBuffer (`src/session/OutputBuffer.ts`) should stay dumb (pure buffering) — escape-sequence awareness belongs upstream.

### 2. SessionManager state model has the right shape

`TerminalSession` already has `initialCwd?: string` from the just-archived change. Add `currentCwd?: string` alongside it. New `setCurrentCwd(sessionId, cwd): void` method paired with the existing `getInitialCwd`, plus a new `getCurrentCwd(sessionId): string | undefined` accessor.

### 3. openFileLink resolver chain — insert + extend

`src/providers/openFileLink.ts:39-61` builds candidates as (1) absolute, (2) initialCwd, (3) workspaceFolders. New order: (1) absolute, **(2) currentCwd**, (3) initialCwd, (4) workspaceFolders, **(5) `vscode.workspace.findFiles` fallback**. The deps interface gains `getCurrentCwd` and `findFiles`. Existing tests compose cleanly.

### 4. OSC 7 wire format has two terminator variants

From `docs/research/20260521-osc7-implementation.md`:

- `ESC ] 7 ; file://host/path BEL` — common on macOS (Apple zsh hook), iTerm2
- `ESC ] 7 ; file://host/path ESC \` (ST) — VTE/GNOME Terminal, VS Code's xterm addon

Both must be supported. Path payload is URL-encoded (`%20` for space). Parser must keep a pending buffer across chunk boundaries.

### 5. OSC 633 is VS Code's proprietary cwd reporting

VS Code's shell-integration script emits `OSC 633 ; P ; Cwd=... ST`. Useful when the user has VS Code's shell-integration script active in their rc files (a small minority for our use case — but cheap to add). Optional secondary path.

### 6. Zero-config shell landscape

- **macOS default zsh (Catalina+)** — emits OSC 7 via Apple's shipped `update_terminal_cwd` hook (Terminal.app default). ✓
- **fish** — emits OSC 7 in interactive sessions by default. ✓
- **Ubuntu/Debian/Arch bash** — generally does NOT emit OSC 7 without sourcing `vte.sh` (login shells only, fragile). ✗

Realistic v1 outcome: macOS users (the primary platform) get cwd tracking with zero config. Linux bash users still hit the stale-cwd path UNLESS the findFiles fallback rescues them. Documented as a known limitation; shell-integration script injection is a deferred follow-up.

### 7. Adversarial OSC 7 is bounded threat

A malicious program in the terminal can emit fake OSC 7 to misdirect our cwd state. Impact ceiling: the existing **out-of-workspace confirm modal** (from `add-clickable-file-paths` D8) still fires when the redirected cwd makes a resolved path land outside the workspace. We MUST sanitize the OSC 7 payload (decode percent-encoding, normalize via `path.resolve`, reject non-absolute) to avoid path-injection oddities, but the confirm modal is the real defense.

### 8. Test infrastructure

- `src/pty/PtySession.test.ts` has `createMockNodePty` factory with `getControls().emitData(string)` — emits chunked data through the callback. Perfect for testing the OSC 7 parser at the seam.
- `src/test/__mocks__/vscode.ts` has `workspace.fs.stat` but NOT `workspace.findFiles`. Need to add a stub: `findFiles: (include, exclude?, maxResults?) => Promise<Uri[]>` defaulting to `[]`.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| PtySession data scan | Pass-through to user callback | Intercept + scan for OSC 7 (BEL+ST), pending buffer across chunks | New pure parser module `oscParser.ts` + wire-up in PtySession |
| SessionManager state | `initialCwd` field + `getInitialCwd` accessor | `currentCwd` field + `setCurrentCwd` + `getCurrentCwd` | Add field + 2 methods |
| Opener resolver | absolute → initialCwd → workspaceFolders | + currentCwd (new step 2) + findFiles (new step 5) | Modify `buildCandidates` + extend `OpenFileLinkDeps` |
| Opener tests | 17 tests for v1 | + currentCwd resolution + findFiles fallback + ambiguity guards | Add ~4 new tests |
| vscode mock | `fs.stat`, `Uri`, `FileType`, `Range` | + `workspace.findFiles` stub + `__setFindFiles` helper | Extend mock |

## Options

Two orthogonal decisions remain.

### D1 — OSC variants to support

#### Option A — OSC 7 only
Single parser pass for `ESC]7;...BEL` and `ESC]7;...ST`. Covers macOS zsh + fish (the primary zero-config wins). Smaller surface.

#### Option B (Recommended) — OSC 7 + OSC 633 (`P;Cwd=...`)
Add a second pattern for VS Code's proprietary `OSC 633;P;Cwd=<path>;<nonce>ST`. Users who already opted into VS Code's shell integration get cwd tracking too. ~10 extra lines of parser code; same chunk-buffer infra.

#### Option C — OSC 7 + 633 + iTerm2 1337 (`CurrentDir=`)
Adds iTerm2's variant. Overkill — iTerm2 users on macOS already get OSC 7 via Apple's zsh hook. Rejected.

### D2 — findFiles fallback ambiguity handling

#### Option α (Recommended) — First match only, capped at 1 result
`vscode.workspace.findFiles("**/" + path, "{**/node_modules/**,**/.git/**}", 1)`. Simplest. Risk: in a `~/` workspace with multiple checkouts, the first match might not be what the user clicked. Mitigated by: out-of-workspace confirm modal still gates anything outside the project; relative paths typically come from a specific tool context which matches one checkout in practice.

#### Option β — Search with maxResults=2; show quick-pick if 2 results
If exactly 1 → open; if 2 → show `vscode.window.showQuickPick` with both paths; if 0 → fall through to "File not found". Better UX for ambiguity. ~15 extra lines + new UX surface.

#### Option γ — No findFiles fallback
Skip findFiles. Trust OSC 7 only. Linux bash users still hit stale-cwd. Rejected — defeats much of the value.

## Risks

1. **Chunk-boundary parser bugs** — OSC 7 split across two `onData` callbacks could be missed if the pending buffer isn't handled correctly. *Mitigation*: pure-function parser with state object, unit-test with deliberately split chunks at every byte offset of a known sequence.
2. **Pending buffer unbounded growth** — A malicious program could send `ESC]7;` and never terminate, growing our buffer indefinitely. *Mitigation*: cap pending buffer at 4096 bytes; on overflow, drop the open OSC and resume scanning.
3. **OSC 7 hostname mismatch** — `file://otherhost/path` from an SSH session. *Mitigation*: accept any hostname; we don't have a reliable "local" signal in this context. Resolution chain + confirm modal still gates.
4. **findFiles perf in large workspaces** — Search with `~/` as workspace root could be slow. *Mitigation*: include `node_modules`/`.git` exclusion glob; cap at 1-2 results; use VS Code's built-in search index (already optimized).
5. **Stale cwd after subshell exit** — User runs `bash` in zsh, `cd`s, `exit`. The parent zsh's cwd is unchanged but the subshell emitted OSC 7. Our tracker shows the subshell's stale value. *Mitigation*: accept; better than nothing; not a regression vs initialCwd.

## Open Questions

- **None blocking** — D1 and D2 are the Gate 1 decisions. All other design choices (parser internals, sanitization rules, threat model defaults) follow research recommendations.
