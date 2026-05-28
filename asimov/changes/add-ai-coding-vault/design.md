# Design: add-ai-coding-vault

## Architecture

New host module `src/vault/` reads agent session stores and synthesizes launch commands. Data flow:

```
agents' on-disk files               ┌─ ClaudeReader (jsonl)
(~/.claude, ~/.codex, ~/.local…)    ├─ CodexReader  (sqlite→jsonl fallback)
        │                            └─ OpenCodeReader (sqlite)
        ▼                                   │
  VaultService.list() ──aggregate/sort/dedup/defensive──▶ VaultSessionEntry[]
        │                                                        │ IPC: vaultSessionsResponse
        ▼ (resume/fork)                                          ▼
  LaunchBuilder.build(entry, mode) ──▶ {file,args,env,cwd} ──▶ SessionManager.createSession(viewId, {command,env,cwd})
        ▲                                                        ▲
        │ IPC: requestVaultSessions / vaultResume / vaultFork    │
        └──────────────── VaultPanel (webview, file-tree-style) ─┘
```

The vault holds **no persistent state of its own** — every open re-reads the source files (D2). SQLite is read through the host `sqlite3` binary (D3). Resume/fork reuse the existing `SessionManager.createSession` spawn path (`src/session/SessionManager.ts:340-500`).

## Decisions

### D1: Data-driven registry — fully for launch, partially for reading (honest scope, per oracle)
Agents are TS records (`AgentVaultDefinition`) in `src/vault/registry.ts`. Two different degrees of data-drivenness:
- **Launch is fully data-driven:** `LaunchBuilder` consumes the record's `resumeCommand`/`forkCommand` templates + `authEnvAllowlist`/`forkMinVersion` — adding an agent's launch needs only a record, no launcher code.
- **Reading is per-agent, not record-only:** each agent's on-disk path layout + file schema + parse rules differ even within the same `format` (Claude's `projects/<enc-cwd>/*.jsonl` ≠ Codex's `sessions/**/*.jsonl`; Codex's `threads` SQL ≠ OpenCode's `session` SQL). So a new agent of an existing `format` still needs a small reader (or registry-supplied path-template + column-map if we later parameterize). The shared, reusable substrate is the `format` machinery (`readSqlite`, jsonl streaming, defensive skip-and-count), not a single generic reader.

*Rejected:* a `switch (agent)` scattered across launcher + readers. Mirrors cmux, which likewise has per-agent `load<Agent>Entries` readers behind a shared registry (`SessionIndexStore.swift`, `VaultAgentRegistry.swift:12-43`).

### D2: Agents' own files are the source of truth — vault persists nothing
We read the live files on each `list()` and never build/sync our own index DB. *Rejected:* a cached index in `workspaceState`/`storageUri` — it adds staleness, invalidation, and a second copy of transcript-derived data (privacy). Re-reading is cheap (metadata only, bounded `LIMIT`).

### D3: SQLite via the host `sqlite3` CLI in read-only JSON mode — no new dependency
Two of three agents (Codex, OpenCode) store SQLite. AT ships only `strip-ansi` as a runtime dep. We read by copying the DB+`-wal`+`-shm` to a temp dir (WAL-safe, `SessionIndexStore+CodexSQL.swift:25-55`) and running `sqlite3 -readonly -json <copy> "<static SELECT>"`, parsing the JSON array. *Rejected:* `better-sqlite3` — a native module needing Electron-ABI rebuilds alongside node-pty for marginal benefit here. **Constraint:** macOS ships `sqlite3` (≥3.37, supports `-json`); AT is macOS-only. The SELECTs are **static** (search/filter happens client-side in the panel), so no untrusted value enters the SQL string.

**Return contract (per oracle):** `readSqlite()` returns `{ rows, status, error? }` where `status ∈ { ok, no-db, no-sqlite3, query-error }` — NOT a bare `[]`. This disambiguates "db absent" (Codex → try JSONL fallback; OpenCode → 0 entries) from "genuinely empty" from "tooling broken" (→ count as unreadable + surface). Capability is probed once via `sqlite3 -readonly -json :memory: "select 1"` (covers both binary-present AND `-json` supported); a query/snapshot failure retries once before degrading.

### D4: Metadata-only — a single bounded title preview is the ONLY transcript-derived field
Readers extract id/cwd/timestamp/model/flags plus **one bounded title preview**. Be honest (per oracle): that preview IS transcript content (the first user message) and may contain secrets — so it is the *only* message-derived value we touch, and it is **truncated (≤120 chars) + newline-stripped** at read time, never persisted, never cached, never sent off-machine. Full message bodies are never read past the first preview line. Transcript preview (cmux A6) stays out of scope. (A future "hide titles / private mode" toggle is a cheap follow-up if needed.)

### D5: Resume/fork reuse `SessionManager.createSession` via its `shell`/`shellArgs` params (+ a small `env` extension)
A launch is just a new terminal whose spawned executable IS the agent's resume/fork invocation. Verified against `src/session/SessionManager.ts:346-409`:
- The existing `createSession(viewId, webview, { shell, shellArgs, cwd })` spawns an arbitrary executable as `shell` with `shellArgs` as **argv** — exactly the argv path D9 needs. No new PTY route.
- Shell-integration injection **auto-skips** unrecognized executables (`SessionManager.ts:403` returns null for `claude`/`codex`/`opencode`), so the agent spawns cleanly with no OSC wrapping.
- `PtyManager.buildEnvironment()` already clones `process.env`, so host `ANTHROPIC_*` etc. propagate automatically (D6).
- **The one required API change:** add an optional `env?: Record<string,string>` to `createSession` options, merged over `baseEnv` (`SessionManager.ts:395-409`), to carry the per-session `CLAUDE_CONFIG_DIR` override that may differ from the host. (task 1_2)
- **Tab visibility (oracle blocker #2):** the resume/fork host handler MUST mirror the existing `createTab` flow — after `createSession`, post `tabCreated` (`TerminalViewProvider.ts:374-391`) so the spawned PTY appears as a selectable tab. The launcher produces the createSession options; the provider owns the createSession-call + `tabCreated` post.

The agent CLI then re-reads its own files — AT never parses the resumed conversation.

### D6: Auth/config env preservation for Claude (best-effort)
When building a Claude launch, ensure the 8-var allowlist (`RestorableAgentSession.swift:276-286`) + any `CLAUDE_CONFIG_DIR` captured at index time reach the spawn env. In practice host vars already flow via `buildEnvironment` (D5); the explicit override mainly carries a captured `CLAUDE_CONFIG_DIR` that differs from the host. **Best-effort, not guaranteed (per oracle):** a VS Code launched from the Dock may lack the user's login-shell env, and direct-spawn bypasses shell init/PATH — so the agent executable or its auth may still be unresolved. Therefore the launcher MUST surface "executable not found / launch failed" (the `error` IPC message, like `createTab`'s catch at `TerminalViewProvider.ts:392-398`) rather than silently spawning a broken terminal. The allowlist is **version-fragile** — isolated in the registry record's `authEnvAllowlist` so it's one-line to update. (A configurable executable path is a cheap follow-up.)

### D7: Claude cwd-dir encoding mirrored exactly
Encode `cwd → cwd.replace(/\//g, "-")` to find the project dir; when decoding a dir name back to a cwd, replace `-`→`/` and accept only if the path exists on disk (lossy, `SessionIndexStore.swift:846-880`). Matching cmux exactly keeps us compatible with the dirs Claude actually writes.

### D8: Defensive, version-tolerant parsing
Every reader wraps per-entry parsing in try/catch, skips failures, and increments an `unreadable` counter returned with the list. Unknown/missing fields → entry is skipped or fields left undefined, never a throw. The panel surfaces the count (vault-panel spec). This absorbs format drift across agent releases (the core `unresolved-unknown` risk).

### D9: Launch interpolation is argv-based, not a shell string
`LaunchBuilder` emits `{ file, args[] }` (argv array), not a concatenated shell line, so session ids/flags are inert arguments — a session id like `; rm -rf ~` becomes one literal arg. node-pty spawns `file` with `args` directly. *Rejected:* building a `sh -c "<string>"` line (cmux renders a shell string because it pastes into a terminal; we control the spawn, so argv is safer).

### D10: VaultPanel mirrors FileTreePanel's composition, not its Tree
Reuse the panel shape — constructor `deps { host, postMessage, getActiveSessionId }`, header+body+search-bar layout, the typed `postMessage` union — but render a **flat list**, not the virtualized `Tree<FileNode>`. The session count is small (bounded by `LIMIT`); a plain list with a client-side filter is simpler and sufficient. Reference: `src/webview/fileTree/FileTreePanel.ts:50-107` (deps + postMessage type), `:770-929` (header/search-bar). **Mount point:** `#vault-panel` lives inside a new `#aux-region` wrapper (`src/providers/webviewHtml.ts`) stacked directly above `#file-tree`, mounted from `src/webview/main.ts`. It is a collapsible section (default collapsed — header strip only), not hidden. See revised D11.

### D11: Vault is a collapsible section stacked above the file tree (revised 2026-05-29)
The vault is **always present** as a collapsible section directly above the file tree inside `#aux-region`, not an exclusive panel that replaces the file tree. Both are visible together; the vault opens/collapses independently like the file tree. This **supersedes** the original `AuxiliaryPanelManager` single-visible-exclusivity model, per user request ("vault luôn ở đó, ngay trên file tree, ẩn hiện y như file tree").
- `#aux-region` (`webviewHtml.ts`) is the sized edge element: it carries `--file-tree-size`, the `file-tree--{pos}` order/border, and the resize sash (which now resizes the whole region vs. the terminal). Its internal axis follows the dock: **column** for top/bottom (two stacked horizontal bands — vault on top, file tree below) and **row** for left/right (two side-by-side vertical columns). Plain `row` in both docks keeps the reading order consistent: **AI Vault first, then File Tree** (DOM order). The collapse tween is disabled for left/right (it snaps) because animating panel width while the header flips to vertical text reflows every frame and reads as jank; top/bottom keep the smooth height animation.
- Inside the region, both sections use `flex: 1 1 0` when expanded (even split) and `flex: 0 0 24px` (header strip) when collapsed; whichever is expanded fills. When both collapse, the region hugs its two headers (`:has(> .vault-panel.vault-collapsed)`), and the sash hides.
- **Left/right collapse = vertical strip (restored 2026-05-29, per user).** Because the region lays out as a row in left/right, a collapsed section becomes a thin vertical strip with a rotated (`writing-mode: vertical-rl`) header — the classic activity-bar look — independently per section (the vault can be a strip while the file tree stays open, and vice-versa). This restores the pre-pivot UX (the earlier revision had flattened all positions to a horizontal 24px header). Order is fixed AI Vault → File Tree; the collapse snaps (no tween) in left/right. Top/bottom keep the horizontal header strip and the height animation.
- Two entry points toggle the vault: its own clickable header chevron, and a toggle button in the file-tree header toolbar (`FileTreePanel` `onToggleVault`). The `openVault` command/menu now expands + refreshes the section.
- Collapsed state persists as `vaultCollapsed?: boolean` in `WebviewState` (absent → collapsed default).
- `AuxiliaryPanelManager` (+ its test) and the `auxiliaryPanelActive` field are deleted.
- **Freshness + context:** the vault re-reads its list whenever it becomes visible (expand/open, **and the view itself becoming visible via `viewShow`**) and whenever the active pane changes while expanded (`SplitTreeRenderer.onActivePaneChange` + `switchTab` + the leaf-driven `focusin` branch → `main.ts` `syncVaultToActivePane`; the `focusin` wiring is required because it can win the focus race against the leaf `mousedown`). A "This folder only" toggle (search row, persisted as `vaultFolderOnly`) scopes the list client-side to the active pane's cwd subtree. The cwd is **pulled live** on every render via the `getContextCwd` dep (→ OSC7-tracked `instance.cwd`), not merely pushed — so toggling the filter scopes immediately even when OSC7 fired after mount (a pushed-only value was often null at mount → the toggle was a no-op). `isWithin` normalizes trailing separators / roots. Live `cd`-following within an already-focused pane is still a future enhancement (would need an OSC7 change callback from `TerminalFactory`).
*Rejected:* single-visible exclusivity (original D11) — the user wants both panels visible at once, vault stacked above the tree.

## Interfaces

```ts
// src/vault/types.ts — shared across all tasks
export type SessionStoreFormat = "jsonl" | "sqlite";

export interface AgentVaultDefinition {
  id: string;                           // "claude" | "codex" | "opencode" | …
  displayName: string;
  detect: { executable: string; argvContains?: string[] };
  // `pathTemplate` documents where sessions live; actual resolution lives in
  // the per-agent reader (D1). `sessionIdSource` describes id derivation.
  sessionStore: { format: SessionStoreFormat; pathTemplate: string };
  sessionIdSource: string;              // "filename-stem" | "threads.id" | "session.id"
  resumeCommand: CommandTemplate;       // tokens: {{sessionId}} {{sessionPath}} {{executable}}
  forkCommand?: CommandTemplate;
  forkMinVersion?: string;              // e.g. "1.14.50" (opencode)
  cwdPolicy: "preserve";                // MVP: always launch in the session's recorded cwd
  authEnvAllowlist?: string[];          // claude's 8 vars
}

export interface CommandTemplate {
  executable: string;                   // "claude" | "codex" | "opencode"
  args: Array<string | FlagFragment>;   // static tokens + optional flags
}
// `valueTemplate` ({{value}} placeholder) supports codex's `-c model_reasoning_effort=<e>`.
export interface FlagFragment { flag: string; from: keyof VaultSessionEntry["flags"]; valueTemplate?: string; }

export interface VaultSessionEntry {
  id: string;                           // "<agent>:<sessionId>", globally unique
  agent: string;                        // definition id
  sessionId: string;
  title: string;                        // preview only (D4)
  cwd: string;
  modified: number;                     // epoch ms; list sorted desc
  flags: { model?: string; permissionMode?: string; approval?: string;
           sandbox?: string; reasoningEffort?: string; agent?: string; configDir?: string };
  canFork: boolean;                     // resolved against forkMinVersion at list time
}

export interface VaultListResult { entries: VaultSessionEntry[]; unreadable: number; }

// IPC additions (src/types/messages.ts)
// webview→host:
interface RequestVaultSessionsMessage { type: "requestVaultSessions"; }
interface VaultResumeMessage { type: "vaultResume"; entryId: string; }
interface VaultForkMessage   { type: "vaultFork";   entryId: string; }
// host→webview:
interface VaultSessionsResponseMessage { type: "vaultSessionsResponse"; result: VaultListResult; }
```

## Design Constraints
- **macOS-only / external CLIs:** paths (`~/.claude`, `~/.codex`, `~/.local/share/opencode`) and `sqlite3` assume macOS; everything is gated behind file-existence + binary-presence checks, degrading to empty (D3, D8).
- **Format drift:** all field names/SQL/flag orders are pinned to the 2026-05 shapes documented in `docs/research/20260528-cmux-vault-mechanism.md`; isolated per reader so a drift fix touches one file.
- **No `vscode.lm` / no network:** the entire feature is local file + process I/O.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| Per-agent readers | 3rd-party formats undocumented & version-fragile (`unresolved-unknown`) | D8 defensive parsing + `unreadable` count; one reader file per agent; fields pinned to research doc; unit tests over captured fixtures (tasks 2_2–2_4). |
| SQLite access | New dep vs. missing system `sqlite3`; WAL lock contention | D3: shell to `sqlite3 -readonly -json` over a temp WAL-safe copy; graceful degrade if absent (task 2_1). |
| Privacy | Reading files with code/secrets (`security-privacy`) | D4 metadata-only, no transcript bodies persisted/sent, no egress; enforced by spec scenario + reader unit tests (tasks 2_2–2_5). |
| Launch | Crafted session value → command injection (`security-privacy`) | D9 argv-array spawn (no shell string); validate id/flags; spec scenario + unit test (task 3_1). |
| Resume correctness | Resumed Claude hits wrong account | D6 auth-env allowlist + captured `CLAUDE_CONFIG_DIR` (task 3_1). |
| Fork on OpenCode | Flag unsupported on older versions | version probe vs `forkMinVersion` 1.14.50; `canFork=false` hides the action (tasks 2_5/3_2). |
