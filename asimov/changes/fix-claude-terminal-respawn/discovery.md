# Discovery: fix-claude-terminal-respawn

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `asm memory search` |
| Architecture Snapshot (PTY env) | Done | finder subagent + direct read |
| External Research (Claude Code bundle) | Done | general-purpose agent (de-minified `claude` binary) |
| Constraint Check (live env + lockfiles) | Done | direct `env` / `ls ~/.claude/ide` |

## Key Findings

### 1. Symptom & true mechanism

Reported: in an Anywhere Terminal → run `claude` → approve a command → the IDE's **native** terminal/window reopens and steals focus. Observed IDE here is **Antigravity IDE** (a VS Code fork), pid 41387.

The "on approve" timing is a **red herring**. Claude has no "open/focus terminal" IDE call at all (its only IDE messages are `openFile`/`openDiff`/`closeAllDiffTabs`/`close_tab`/`getDiagnostics`/`set_permission_mode`/`ide_connected`; `openFile` uses `makeFrontmost:false`). What actually happens:

1. `claude` boots inside our PTY. A startup effect runs a 30 s loop that **discovers** `~/.claude/ide/*.lock` files and keeps any whose `workspaceFolders` contains claude's cwd — a **pure path match**, ignoring `TERM_PROGRAM`/`CLAUDE_CODE_SSE_PORT`. The Antigravity lockfile for this repo matches.
2. The discovered connection is opened **only if** this gate passes (verbatim from the bundle):
   ```
   (E_().autoConnectIde || q || Nv() || process.env.CLAUDE_CODE_SSE_PORT || K
        || bH(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE))
     && !PK(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE)
   ```
   Here `Nv()` is **false** (see §2), SSE port unset, no flags — the live-true disjunct is **`autoConnectIde === true`**, persisted to `~/.claude.json` once the user answered "Yes" to Claude's one-time "auto-connect to IDE?" dialog.
3. When the gate passes, Claude registers a `ws-ide` MCP server, opens the WebSocket to Antigravity, and sends `ide_connected`. **Antigravity reacts by raising its window / focusing its native terminal** — that is the "respawn". The handshake completes ~around the first interaction, which is why it *looks* tied to approving a command.

### 2. Why this is NOT the `TERM_PROGRAM=vscode` path

`buildEnvironment()` (`src/pty/PtyManager.ts:213`) already overwrites `TERM_PROGRAM = "AnyWhereTerminal"`. In the bundle, `Nv()` (VS Code-family terminal detection) is `_P_() || BiH() || FORCE_CODE_TERMINAL`; `_P_()` keys off `TERM_PROGRAM==="vscode"` (false here) and `BiH()` only matches JetBrains. So `Nv()` is false → the env-based detection and the `code --install-extension` auto-install spawn (gated by `miH()` which needs `Nv()`) **never run**. Stripping `TERM_PROGRAM`/`CLAUDE_CODE_SSE_PORT` is therefore neither necessary nor sufficient — the lockfile-by-workspace match ignores both.

### 3. The exact lever

The gate is `(...big OR...) && !PK(process.env.CLAUDE_CODE_AUTO_CONNECT_IDE)`. The bundle's helpers:
```js
bH(H) // truthy:  ["1","true","yes","on"]
PK(H) // falsy:   ["0","false","no","off"]  (case-insensitive, trimmed); undefined → false
```
Setting **`CLAUDE_CODE_AUTO_CONNECT_IDE=false`** makes `!PK("false") === false`, collapsing the **entire** gate regardless of `autoConnectIde:true`, any matching lockfile, an SSE port, or `--ide`. Verified scope:
- (a) Stops the auto-connect WS/`ide_connected` → **stops the focus-steal**.
- (b) Manual `/ide` still connects (that command path has **no** `bH`/`PK` check).
- (c) `TERM_PROGRAM`, shell-integration, and Claude's xterm.js rendering are untouched.
- `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1` alone is **insufficient** (only gates the `code` install spawn, not the WS connect).

### 4. Where env is built (insertion point)

- `src/pty/PtyManager.ts:193` `buildEnvironment()` — clones `process.env`, sets `TERM/COLORTERM/LANG/TERM_PROGRAM/TERM_PROGRAM_VERSION`. **This is the single base-env builder for every PTY** (manual shells AND vault agent launches go through `SessionManager.createSession` → `buildEnvironment()` at `SessionManager.ts:412`). One insertion here covers all cases.
- Vault agent launches additionally overlay a Claude auth allowlist (`src/vault/LaunchBuilder.ts:89`, `src/vault/registry.ts` `CLAUDE_AUTH_ENV_ALLOWLIST`) — not relevant to the trigger, but confirms agents reuse the same spawn path.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| PTY base env (`buildEnvironment`) | clones host env; no IDE-connect control | default-off for Claude IDE auto-connect | inject `CLAUDE_CODE_AUTO_CONNECT_IDE=false` |
| User override | none | escape hatch for users who want auto-connect | respect a host-set value (don't clobber) |
| Test coverage | env tests exist for `CLAUDE_CONFIG_DIR` reaching `pty.spawn` | assert the new var present + override respected | add `buildEnvironment` unit test |

## Options

### Option A — Hardcode `CLAUDE_CODE_AUTO_CONNECT_IDE=false` in `buildEnvironment`, respecting an existing host value (Recommended)
One line in the base-env builder: set the var to `"false"` only when the host env hasn't already set `CLAUDE_CODE_AUTO_CONNECT_IDE`. Fixes manual `claude` and vault agents in one place; zero config surface; power users keep `/ide` and can `export CLAUDE_CODE_AUTO_CONNECT_IDE=true` to opt back in. Aligned with the AI Coding Vault goal (agents live in the tab, not the IDE).

### Option B — Same injection, gated by a new VS Code setting (`anywhereTerminal.claude.autoConnectIde`, default off)
Adds a discoverable toggle in Settings UI; default injects the kill switch, flipping it to `true` skips injection. More surface (package.json contribution + config read) for a behavior most users won't touch — env escape hatch already covers the rare opt-in.

### Option C — Strip leaked IDE env vars (`TERM_PROGRAM`, `CLAUDE_CODE_SSE_PORT`, `VSCODE_*`)
Rejected: the trigger is lockfile-by-workspace, which ignores these vars, so stripping them does **not** stop the connect; stripping `TERM_PROGRAM` would also break our own shell-integration and change Claude's rendering heuristics.

## Risks

1. **Users who liked Claude auto-driving the IDE (open diffs/diagnostics in editor) lose it by default** — Mitigation: manual `/ide` still works; host-env opt-in (`CLAUDE_CODE_AUTO_CONNECT_IDE=true`) preserved by Option A's "don't clobber" rule. Documented as a deliberate default.
2. **Claude's env contract could change in a future version** — Mitigation: the var is read-from-env and documented behavior; if removed, the fix becomes a harmless no-op (no breakage), and the lockfile gate would need re-checking. Low likelihood.
3. **Scope creep to other agents (cursor-agent, codex)** — Out of scope: this change fixes Claude only; analogous IDE-connect behavior for other agents is a separate follow-up (relates to in-flight `support-cursor-integration`).
