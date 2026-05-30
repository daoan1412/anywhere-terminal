# Discovery: cache-vault-load

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Architecture Snapshot (vault load pipeline) | Done | finder subagent |
| Internal Patterns (persistence + data sources) | Done | finder subagent |
| Constraint Check (deps, existing specs, fs adapter) | Done | direct read |
| External Research | Skipped | not needed — VS Code storage + fs mtime are well-known |
| Memory Recall | Skipped | `asm memory` index not built in this repo |

## Key Findings

### 1. The vault list is read fully on every open — no cache exists

`VaultService.list()` (`src/vault/VaultService.ts:82`) is stateless: it fans out to all three agent
readers via `Promise.allSettled` on **every** `requestVaultSessions` message, merges, resolves fork
support, and sorts. The webview re-requests on the collapsed→expanded transition
(`VaultPanel.setCollapsed`, `src/webview/vault/VaultPanel.ts:617`). Nothing is cached host-side — this
is an explicit current design decision (D2: "Stateless; re-reads on each list()", `extension.ts:121`).

### 2. The dominant cold-open cost is Claude's per-file tail read

`readClaudeSessions` (`src/vault/readers/claudeReader.ts:532`) enumerates `~/.claude/projects/*/ *.jsonl`
and for **each** file runs `buildClaudeEntry` → `parseClaudeFile` (stream head) **plus**
`readLatestAiTitle` (`claudeReader.ts:64`) which reads the **last 64 KB of every file** to find the
freshest `ai-title`. That is O(N files × 64 KB) of I/O on every open, dominating latency for users with
many sessions. SQLite agents (Codex `state_5.sqlite`, OpenCode `opencode.db`) WAL-safe-clone the DB
(`src/vault/sqlite.ts`) before a bounded `LIMIT 500` query — cheap on APFS (copy-on-write clone) but the
byte-copy fallback is slow for OpenCode's large DB.

### 3. Strong prior-art persistence pattern already in the codebase

`SessionStorage` (`src/session/SessionStorage.ts`) persists session snapshots to a **sidecar JSON** at
`<storageUri>/snapshots/index.json` using **atomic temp+rename**, **mode `0o600`** (owner-only — its
documented mitigation for persisting credential-bearing terminal buffers, round-1 [W5]), a **version
guard** that discards unsupported payloads, and generation counters for write races. Decision **D17**:
the sidecar is the single source of truth. The cache here should mirror this pattern.

### 4. Data model already supports incremental refresh

`VaultSessionEntry` (`src/vault/types.ts:119`) already carries `modified` (epoch ms — `mtimeMs` for
filesystem agents, `updated_at_ms`/`time_updated` for SQLite). Each agent's backing files are
stat-able: Claude per session file; SQLite via `dbPath` (+`-wal`) resolvers (`codexReader.codexDirs`,
opencode resolver `opencodeReader.ts:125`). So change-detection by `(mtimeMs, size)` is feasible at
per-file (Claude) and per-store (SQLite) granularity. Detail reads are already on-demand & bounded
(`detail.ts`) — **not** part of the cold-open cost; only the list matters here.

### 5. Two normative requirements collide with caching

- `vault-panel/spec.md:36` ("Refresh on open"): *"the host SHALL hold **no index cache** beyond serving
  the current request."*
- `agent-session-index/spec.md:32` ("Metadata-only, bounded title preview, no egress"): the bounded
  title *"SHALL **NOT be persisted or cached**"* — privacy rationale (titles originate from user
  messages, MAY contain sensitive content).

Both must be MODIFIED. The privacy clause makes this a **`security-privacy`** change. Mitigation precedent
exists: `SessionStorage` already persists raw terminal scrollback (strictly more sensitive than a
≤120-char title) to `0o600` owner-only files, never off-machine.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Host-side list cache | none (stateless) | persisted list served instantly on open | new `VaultCacheStore` + cache in `VaultService` |
| Refresh path | full re-read every open | re-read only changed sources | per-file/per-store freshness stamps in readers |
| IPC | single `vaultSessionsResponse` | cached-then-fresh (two responses) | `fromCache` flag + two-phase handler |
| Webview render | re-renders on every response | no-op when nothing changed | entries-signature guard in `VaultPanel.render` |
| Persistence pattern | `SessionStorage` sidecar (0o600, atomic, versioned) | same for vault cache | reuse pattern in new store |
| Privacy posture | titles forbidden to persist | titles cached at rest (0o600, local) | MODIFY spec + documented mitigation |

## Options

### Option A — In-memory cache only (no disk)
Cache the list in the ext-host process. **Rejected**: dies on window reload / VS Code restart — exactly the
"every time I open VS Code" case the user wants fixed. Does not meet the requirement.

### Option B — Persist full list; background full re-read (no incremental)
Persist the merged list; on open serve it instantly, then run the existing full `list()` in the background.
Fixes *perceived* latency but still does the expensive 64 KB-per-file scan every open — violates the user's
explicit "only update new data". Partial.

### Option C — Persisted cache + incremental refresh (Recommended)
Persist the list to a `0o600` sidecar under `globalStorageUri`; serve it instantly on open; then refresh
re-reading **only** sources whose backing files changed (Claude per-session-file mtime+size; SQLite per-DB
mtime+size → skip clone+query when unchanged); webview re-renders only when entries actually differ. Meets
both goals (instant display + "only update new data"), mirrors `SessionStorage`, and is fully testable via
the existing reader/dep injection seams.

## Risks

1. **Privacy — titles persisted at rest** — Mitigation: `0o600` owner-only file under `globalStorageUri`,
   never sent off-machine; mirrors `SessionStorage`'s established posture; MODIFY the spec explicitly.
2. **Stale cache shown briefly** — Mitigation: always refresh on open; refresh is fast (incremental);
   bounded staleness (≤ one open); no-op render guard means an unchanged refresh is invisible.
3. **Re-render disrupts open preview/scroll** — Mitigation: skip re-render when entries signature unchanged
   (the common case); preview overlay is separate DOM and survives a list re-render.
4. **Cache corruption / multi-window writes** — Mitigation: atomic temp+rename, version guard → treat
   corrupt/mismatched as cache-miss (full rebuild); last-writer-wins is fine for a cache (content converges).
