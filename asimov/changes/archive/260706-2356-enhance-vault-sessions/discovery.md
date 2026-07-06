# Discovery: enhance-vault-sessions

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `bun run asm memory search` (vault prior decisions) |
| Architecture Snapshot | Done | finder subagent (vault end-to-end) |
| Internal Patterns | Done | finder subagent (rename/metadata anchors; watcher infra) |
| External Research | Done | librarian subagent → `docs/research/20260707-vault-session-formats.md` |

## Key Findings

### 1. Vault reads are metadata-only today; rename was explicitly deferred
Prior change `260529-0303-add-ai-coding-vault` set the privacy posture: read only metadata (id, cwd, title preview, timestamp, model/flags), **never write** into agent files. `agent-session-index` spec still says title preview is "the ONLY transcript-derived value" and rename is not offered. This change intentionally adds rename — safest form is a **read-only-of-agent-files** sidecar (we never mutate agent-owned stores).

### 2. Per-agent readers + entry shape
- Claude: JSONL scan of `~/.claude/projects/<slug>/<sessionId>.jsonl` (`claudeReader.ts`). Already parses `gitBranch` + `model` into `ClaudeFileFields` (claudeReader.ts:70-160) but only `title`/`model` reach the entry.
- Codex: SQLite `~/.codex/state_5.sqlite` `threads` (fallback JSONL `~/.codex/sessions/**`). SELECT already includes `git_branch, model` (codexReader.ts:44-46) but branch is dropped in `mapThreadRow` (codexReader.ts:136-150).
- OpenCode: SQLite `~/.local/share/opencode/opencode.db` (`session`+`message`). Model from latest assistant JSON; **no git branch** first-class (only `session.directory`).
- Entry id = `<agent>:<sessionId>`; `VAULT_AGENT_IDS=["claude","codex","opencode"]` compile-enforced (types.ts:27-51). `VaultSessionEntry` (types.ts:122-151) carries `title`, `cwd`, `modified`, `flags` — **no branch, no custom-name** field.

### 3. Refresh is manual + eager-on-open; no watcher yet
- `VaultService.refresh()` = stale-while-revalidate, single-flight, incremental per reader (VaultService.ts:86-240); `listCached()` serves last persisted list synchronously.
- Refresh button posts `{type:"requestVaultSessions"}` → `TerminalViewProvider.handleRequestVaultSessions()` (posts cache, then fresh; monotonic `_vaultRefreshSeq` drops stale) (TerminalViewProvider.ts:339-383).
- Cache persisted at `<globalStorageUri>/vault-cache/list.json` (VaultCacheStore.ts).
- **No background FS watcher** — refresh only on button/open.

### 4. Reusable watcher infra already exists (fs-watcher-pool)
- `src/providers/fsWatcherPool.ts` `WatcherPool.subscribe(absPath, onInvalidate)` → refcounted `Disposable`, 150ms debounce, `onDidRequestRehydrate` fires on window-focus rising edge (fsWatcherPool.ts:65-89,247-272). Singleton wired in `extension.ts`, already passed to FileTreeHost. **Directly reusable** for both auto-refresh (task 3) and live-follow (task 4).

### 5. Preview rendering + per-message shape
- `PreviewController.open(entry)` posts `requestVaultSessionDetail`; `FloatingPreviewShell` owns DOM; `previewTimeline.renderTimelineInto()` groups AI-output runs; `previewScrollNav` has scroll-to-top/bottom FAB (PreviewController.ts, previewTimeline.ts, previewScrollNav.ts).
- `previewHeader.ts` supports exactly ONE `chip` (used for subagent @agent). `renderAtoms.buildPreviewMeta()` shows Folder/Modified/Activity — **not model/branch** (previewHeader.ts:14-15,107-112; renderAtoms.ts:17-39).
- Message timeline item = `{ kind:"message"; role; text; timestamp? }` (types.ts:168) — **no model/tokens per message**. Detail readers aggregate tokens into `stats.tokenCount` only (detail.ts:707-715; codexReader.ts:905-915; opencodeReader.ts:400-424). Per-message model+tokens ARE reachable at the emit sites (Claude detail.ts:630-635, Codex codexReader.ts:828, OpenCode opencodeReader.ts:442) but currently discarded.
- `VaultSessionDetail` envelope (types.ts:278-306) carries `stats`, `timeline` (≤400), `truncated`, `partial`.

### 6. Rename + context-menu anchors
- Context menu `VaultContextMenu.ts:46-82` (Resume/Open/Reveal/Copy…) — **no Rename**. Opened at `VaultPanel.ts:159`.
- Row title set at `vaultListView.ts:65` `titleEl.textContent = entry.title || "(untitled session)"`.
- Terminal rename precedent: `CustomNameRegistry.ts` (Memento-backed, fire-and-forget, normalization) — clean template for a vault-scoped registry keyed by entryId.
- IPC pattern: message type in `messages.ts` + case in `TerminalViewProvider` dispatch (renameTab precedent at TerminalViewProvider.ts:843-847).

### 7. Session-file formats for live-follow / metadata (see research doc)
- Claude/Codex = append-only JSONL → tail by byte offset; both carry per-message `model` + `usage`/`token_count` and session `gitBranch`/`git`.
- OpenCode = SQLite (never tail as JSONL) → watch db mtime/WAL + query `time_updated > last_seen`; per-message `data.modelID` + `data.tokens`; no branch column.
- Claude has no explicit context-window field; Codex exposes `model_context_window`; treat "context" as **token usage** (input+cache = prompt/context size, output) with context-window shown when the agent provides it.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Rename | Terminal `CustomNameRegistry` | Vault custom-name registry keyed by `<agent>:<sessionId>` + Rename UI + inline edit | New registry + menu item + IPC + list override |
| Branch display | Claude/Codex parse branch but drop it | `gitBranch?` on entry + header chip | Thread branch through readers → entry → header |
| Per-message model+ctx | Aggregated to `stats.tokenCount` | `model?`/`tokens?` on message timeline items + render | Attach at 3 emit sites + render meta line |
| Auto-refresh | Manual button + `WatcherPool` infra | Watch 3 stores → debounced `refresh()` → push list | Wire watcher→service→webview push |
| Live-follow | On-demand detail + scroll nav | Watch open session file → re-fetch → append/scroll or "new msgs" pill | Watcher on active file + scroll-state + pill UI |

## Options

### Rename persistence

**Option A — Sidecar registry (Recommended)**: store custom names in a VS Code global Memento keyed by `<agent>:<sessionId>`, mirroring `CustomNameRegistry`. Reader-supplied `title` becomes the fallback; custom name overrides in list + preview header. Never writes agent files → zero clobber/format-drift risk, uniform across all 3 agents, fully reversible (clear name → original title). Con: rename not reflected in the agent's own CLI/UI.

**Option B — Native write per agent**: append Claude `custom-title`, append Codex `session_index.jsonl`, `UPDATE session.title` in OpenCode DB. Pro: visible in the agent too. Con: writes into agent-owned stores (OpenCode DB write while `opencode` is running risks lock/conflict; Claude/Codex append must respect format + tail-refresh); 3× the code + per-format fragility; contradicts the standing metadata-only/read-only posture. Rejected for MVP.

### Live-follow re-read strategy

**Option A — Re-fetch bounded detail on change, diff by timeline length/last-timestamp (Recommended)**: reuse existing `getDetail`/`requestVaultSessionDetail`, debounced by watcher. Simple, reuses all parsing, correct for JSONL + SQLite alike. Con: re-parses bounded window each tick (bounded cost, debounced).

**Option B — True byte-offset incremental tail**: keep per-file offset, parse only appended bytes. Lower cost but new parsing path per agent, doesn't fit OpenCode SQLite, more code + edge cases. Deferred.

### "Context" per message interpretation

Show a compact per-assistant-message meta line: **model** + **tokens** (context = input+cache prompt tokens; output tokens), plus **context-window** when the agent provides it (Codex `model_context_window`). Session **branch** is a preview-header chip (+ list row tint optional), shown only when available (Claude/Codex; omitted for OpenCode).

## Risks

1. **Watching whole `~/.claude/projects` recursively is heavy** — scope watcher globs to store roots + debounce (WatcherPool already debounces 150ms; add coalescing on refresh). Refresh is incremental/cached so churn cost is bounded.
2. **OpenCode DB is WAL SQLite** — watch the db/-wal file, requery deltas; never tail. Already how `opencodeReader` reads.
3. **Live-follow re-parse on every append** — debounce (≥400ms), reuse single-flight, only re-render preview when timeline actually changed (length or last timestamp).
4. **Rename normalization/empty** — reuse `CustomNameRegistry` rules (trim, cap length, empty = clear → revert to reader title).
5. **Scroll "atBottom" detection jitter** — use a threshold (e.g., within N px of bottom) so near-bottom counts as bottom; capture before re-render, restore after.
