# Proposal: track-terminal-cwd

## Why

The v1 of clickable file paths (`add-clickable-file-paths`, archived 260521-0215) resolves relative paths against the PTY's **initial** cwd — stale after the user runs `cd`. Real-world impact, observed during manual smoke: when the VS Code workspace is `~/` and the user `cd`s into a project subdir, paths printed by tools relative to the current pwd fail to open. This change closes that gap by tracking the live cwd via OSC 7/633 escape sequences and adding a workspace search fallback for shells that don't emit cwd updates.

## Appetite

**M** (≤3d) — escape-sequence parser + SessionManager state extension + opener resolver insertion + findFiles fallback + tests across PtySession / SessionManager / openFileLink.

## Scope

### In scope

- Passive OSC 7 listener in `PtySession`: parse `ESC ] 7 ; file://host/path BEL` and `ESC ] 7 ; file://host/path ST` (both terminators). Decode percent-encoding; normalize via `path.resolve`; reject non-absolute payloads.
- Passive OSC 633 listener (same parser): parse `OSC 633 ; P ; Cwd=<path> ST` (VS Code shell-integration emit).
- Chunk-boundary handling: pending buffer across `node-pty` `onData` calls; bounded at 4096 bytes (drop open OSC on overflow, resume scanning).
- `SessionManager`: add `currentCwd?: string` field on `TerminalSession`, plus `setCurrentCwd(sessionId, cwd): void` and `getCurrentCwd(sessionId): string | undefined`.
- `openFileLink` resolver: insert `currentCwd` as step 2 (after absolute, before initialCwd). Add `findFiles` fallback as step 5.
- `findFiles` call shape: `vscode.workspace.findFiles("**/" + msg.path, "{**/node_modules/**,**/.git/**}", 1)` — first match opens.
- Pass-through: raw escape sequences MUST continue to flow to the webview unchanged (xterm.js may render/use them).
- `OpenFileLinkDeps`: add `getCurrentCwd` and `findFiles` to the deps interface. Both providers wire them.
- Tests: unit tests for the OSC parser (BEL + ST terminators, partial chunks, malformed payloads, OSC 633), SessionManager `setCurrentCwd/getCurrentCwd`, openFileLink resolution order, findFiles fallback (positive match + no match + cancellation).

### Out of scope

- **Shell-integration script injection** (bash/zsh/fish snippets that emit OSC 7 on cd). Many shells emit OSC 7 natively (macOS zsh, fish); the cost/benefit of injecting scripts for Linux bash users is deferred until passive-only coverage is shown insufficient in practice.
- iTerm2's OSC 1337 `CurrentDir=` variant — iTerm2 users on macOS already get OSC 7 via Apple's zsh hook.
- Quick-pick UX when `findFiles` returns multiple matches — first-match-only for v1; revisit if false positives become a problem.
- Cross-platform path translation (WSL `/mnt/c/...` → `C:\...`). Out of scope; user can click absolute Windows paths directly.
- Tracking cwd of a subshell vs parent shell (subshell emits OSC 7, parent isn't tracked separately). Documented limitation.
- **SSH / remote-shell precedence (added during section 7)**: when the user opens a local PTY then `ssh`'s into a remote and clicks a relative path printed by the remote shell, the local PID query (step 2 of the resolution chain) reports the LOCAL ssh-client's cwd, not the remote shell's cwd. If a same-named file happens to exist under the local cwd, it will be opened instead of the OSC-reported remote candidate. We accept this tradeoff for v2: SSH+remote-file-clicking is uncommon, opening a same-named local file is recoverable, and we have no clean way to detect "this OSC came from remote" without parsing OSC 7's hostname. Tracked as a follow-up: add hostname awareness to the resolver if SSH usage proves common in practice.

## Capabilities

1. **terminal-cwd-tracking** — PtySession passively parses OSC 7 and OSC 633 escape sequences from PTY output, decodes the cwd payload, sanitizes it, and notifies SessionManager which records it as the session's `currentCwd`.
2. **terminal-clickable-file-paths** (MODIFIED) — the existing capability is extended: resolver inserts `currentCwd` as step 2; adds `vscode.workspace.findFiles` as a final fallback step. Spec delta only — no new/removed requirements; one MODIFIED requirement to update the resolution chain.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — relative paths in terminal output now resolve correctly after `cd` (on shells that emit OSC 7/633). `findFiles` fallback may open files outside the immediate PTY cwd. No new dialogs introduced; existing out-of-workspace confirm modal still applies.
- **E2E required?** NOT REQUIRED.
- **Justification**: project Commands declare E2E as N/A. Behavior is verifiable via unit tests for parser, SessionManager, and opener; manual smoke covers the integrated flow.

## Risk Level

**MEDIUM** — escape-sequence parsing is new for this codebase and operates on UNTRUSTED PTY output. A bug in the parser could mis-track cwd (annoying but contained by the existing confirm modal) or corrupt the data stream (would break terminal rendering — must NOT happen). Mitigation: parser is a pure function with no side effects on the data stream; the listener is an observer that only updates SessionManager state; the original `data` always flows unchanged to the user callback.
