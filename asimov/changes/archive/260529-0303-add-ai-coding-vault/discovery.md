# Discovery: add-ai-coding-vault

> Goal: an "AI coding vault" for AnyWhere Terminal — browse a searchable list of past AI-CLI-agent sessions (Claude Code, Codex…) and resume/fork any of them by spawning the agent's native CLI in a fresh AT terminal. Modeled on cmux's "Vault."

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Prior Design Docs | Done | direct read — `docs/ai-features-warp-cmux.md` (Theme A = Vault, §6 order, §7 matrix), `docs/PLAN-suggest.md` |
| Architecture Snapshot (AT plug-in points) | Done | finder subagent |
| External Research (cmux mechanism) | Done | librarian subagent → `docs/research/20260528-cmux-vault-mechanism.md` |
| Constraint Check (deps) | Done | direct read — `package.json` |

## Key Findings

### 1. What "vault" means (scoped from prior research)
The headline cluster is **Theme A — AI CLI agent orchestration**, items A1–A9 in `docs/ai-features-warp-cmux.md`. The *defining* vault feature is **A4 (cross-agent session index + resume)**, optionally **A5 (fork)**, built on **A9 (a data-driven agent registry)**. None of this needs an AI model, a model API key, or `vscode.lm` — it is pure file/SQLite reads + spawning the agent's own CLI in a PTY. Live process detection (A1) and the "needs attention" notification ring (A3) are *separable* features and are NOT required for browse+resume.

### 2. AT is well pre-wired — but two pieces are missing
From the finder pass (file:line):
- **PTY spawn + env injection** — `SessionManager.createSession` builds `baseEnv` and already has a shell-integration env-injector hook (`src/session/SessionManager.ts:395-409`); `PtyManager.buildEnvironment` (`src/pty/PtyManager.ts:145-172`) is where per-session env tags (e.g. `AT_SESSION_ID`) would be added. *(Only needed if we do live detection — Option C.)*
- **SessionManager** — owns `sessions: Map<id, TerminalSession>`, `createSession()` returns a UUID, exposes `pty.pid`, `initialCwd`, command tracking (`src/session/SessionManager.ts:104-150,340-500`). Resume = call `createSession` with a prebuilt command.
- **Persistence** — `SessionStorage.ts` is two-tier: `workspaceState` (Memento) index + `storageUri` files (`src/session/SessionStorage.ts`). The vault index needs **no persistence of its own** — agents' on-disk files ARE the source of truth; we read them live.
- **Typed IPC** — clear boilerplate: add types in `src/types/messages.ts` (unions at L77-100 webview→host, L796-828 host→webview), dispatch in `src/webview/messaging/MessageRouter.ts`, host handler in `src/providers/TerminalViewProvider.ts:132-150`.
- **Webview UI** — `src/webview/fileTree/FileTreePanel.ts` is a clean structural template (`new Panel(host, postMessage, getActiveSessionId)`) for a future Vault panel.
- **OSC dispatch** — `src/pty/oscParser.ts:170-260` is extensible for OSC 9/777 *(only needed for notifications — out of MVP scope)*.
- **MISSING #1: no argv/env/title process scanner.** `processCwd.ts` does PID→cwd only. Live agent detection (A1) would require building a new `ps`/`/proc` argv+env reader. → reason to defer A1.
- **MISSING #2: no SQLite access.** See Finding 4.

### 3. cmux's concrete mechanism is fully extracted (Claude + Codex)
Persisted in `docs/research/20260528-cmux-vault-mechanism.md`. Copy-pasteable facts:
- **Claude Code:** sessions at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where `encoded-cwd = path.replace(/\//g, "-")` (e.g. `/Users/x/y` → `-Users-x-y`); session id = filename stem. Roots: `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`. Parse per file: `cwd`, `gitBranch`, `permissionMode`, assistant `message.model`, first-user-message title/preview, file **mtime** as the timestamp.
- **Codex:** primary store `~/.codex/state_5.sqlite`, table `threads`, columns `id, rollout_path, cwd, title, model, git_branch, approval_mode, sandbox_policy, reasoning_effort, first_user_message, updated_at_ms` (`WHERE archived = 0 ORDER BY updated_at_ms DESC`). **WAL-safe read:** copy `state_5.sqlite` + `-wal` + `-shm` into a temp dir, open the copy read-only. JSONL fallback: `~/.codex/sessions/**/*.jsonl` (first line `session_meta.payload.cwd`).
- **Resume:** `claude --resume <id> [--model <m>] [--permission-mode <p>]`; `codex resume <id> [-m <m>] [-a <approval>] [-s <sandbox>] [-c model_reasoning_effort=<e>]`.
- **Fork:** `claude --resume <id> --fork-session`; `codex fork <id>`. No version gate for these two.
- **Auth-env preservation (Claude, version-fragile):** re-export whitelist `ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CONFIG_DIR` when launching resume.

### 4. Constraint: AT has near-zero runtime deps — Codex SQLite is the one real fork
`package.json` runtime deps = only `strip-ansi`. No SQLite, no ripgrep. (node-pty is already a native dep, so a native-module toolchain exists.) Reading Codex's primary store therefore needs a decision:
- **(a) `better-sqlite3`** — robust, but a native module needing Electron-ABI rebuilds alongside node-pty.
- **(b) shell out to the `sqlite3` CLI** — zero new dep; macOS ships `sqlite3`. Matches AT's minimal-deps posture. Apply the WAL copy-to-temp trick, run one read-only `SELECT`.
- **(c) Codex JSONL-fallback only** — zero dep, no SQLite at all, but misses sessions only present in the SQLite store (newer Codex writes SQLite-first) → degraded coverage.
Claude needs no SQLite (JSONL only), so a **Claude-only** MVP sidesteps this entirely.

### 5. Privacy posture (security-privacy flag)
The vault reads files that can contain source/secrets. MVP keeps the surface small: **read only metadata** (session id, cwd, title preview from the first user line, timestamp, model/flags) — never render or persist transcript bodies. Resume just launches the agent's own CLI, which re-reads its own files; AT stores nothing. Full transcript preview (A6) is explicitly deferred.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Agent session readers (Claude JSONL, Codex SQLite/JSONL) | nothing | per-agent loaders → metadata list | **build new** (`src/vault/` readers) |
| Agent registry (paths, resume/fork templates, parse rules) | nothing | small data record per agent | **build new** (start hardcoded claude+codex; JSON-extensible later) |
| Searchable session list UI | file-tree panel + Quick Pick patterns exist | a vault list surface | **build new** (reuse a pattern) |
| Resume/fork = spawn CLI in fresh terminal | `SessionManager.createSession` | pass a synthesized command + env | **wire** (small) |
| SQLite access | none | read Codex `threads` | **decide** (Finding 4) |
| Live "which pane runs which agent" (A1) | `processCwd` (cwd only) | argv+env scanner + env-tag at spawn | **defer** (out of MVP) |
| Notifications / attention ring (A3) | OSC dispatch extensible | OSC 9/777 + focus gate + ring | **defer** (separate feature) |

## Options

### Option A — Vault core: Claude + Codex, browse + resume + fork (Recommended)
Registry-backed readers for Claude (JSONL) and Codex (SQLite + JSONL fallback) → one searchable list → resume/fork by spawning the native CLI in a fresh AT terminal. No live detection, no notifications, no model, no transcript rendering. **This is the true "vault."** Appetite **L (~1.5–2 wk)**. Carries the one open dep decision (Finding 4).

### Option B — Claude-only vault core
Identical surface but Claude (JSONL) only — drops Codex and the SQLite question entirely. **Zero new deps**, appetite **M (~3–4 d)**, but covers fewer users. Good if we want to ship the smallest sticky slice and add Codex as a follow-up change.

### Option C — Vault core + live "running now" detection (A1)
Option A plus the missing argv/env process scanner + env-tagging at spawn, so AT shows which open terminal is *currently* running which agent. Sets up future notifications (A3). **Bigger** (L+), adds the new-scanner risk; not required for the browse+resume value.

## Risks

1. **3rd-party session formats are undocumented & version-fragile** — Claude JSONL fields, Codex `threads` schema, and resume-flag names can change across agent releases. *Mitigation:* registry-isolated readers (one file per agent), defensive parsing (skip unparseable entries, never crash the list), pin behavior to the documented 2026-05 shapes, surface "couldn't read N sessions" rather than failing.
2. **Codex SQLite access adds a dependency or a shell-out** (Finding 4) — native-module rebuild pain vs. relying on a system `sqlite3`. *Mitigation:* decide at Gate 1/design; the WAL copy-to-temp read-only pattern avoids lock contention regardless of mechanism.
3. **Privacy — reading user transcripts** (security-privacy) — files may hold secrets. *Mitigation:* metadata-only reads, no transcript bodies persisted or shown in MVP, no network egress; resume re-launches the agent's own CLI.
4. **Resume correctness — auth/account drift** — a resumed Claude session must hit the same account/config. *Mitigation:* port cmux's `CLAUDE_CONFIG_DIR` + `ANTHROPIC_*` re-export whitelist when synthesizing the resume command.
5. **macOS-only assumptions** — paths (`~/.claude`, `~/.codex`) and `sqlite3` presence assume macOS (AT is macOS-only today). *Mitigation:* gate readers behind platform + file-existence checks; degrade to "no sessions found" cleanly elsewhere.
