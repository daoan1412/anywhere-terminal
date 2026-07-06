# Design: enhance-vault-sessions

## Decisions

### D1: Rename via a read-only sidecar registry (never write agent files)

Custom names live in a new `VaultCustomNameRegistry` backed by a VS Code `Memento` (global state), keyed by the entry id `<agent>:<sessionId>` — mirroring the existing terminal `CustomNameRegistry` (fire-and-forget, normalize, in-memory map + persisted map). The registry is constructed once in `extension.ts` with `context.globalState` and **injected into the single shared `VaultService`** (constructed at extension.ts:126-129) — not per-provider, to avoid sidebar/panel inconsistency. `VaultService` exposes `setCustomName(entryId, name)` (delegates to the registry) so the rename handler goes through the service, not a provider-local registry.

At list-serve time `VaultService.overlayCustomNames(entries)` returns **cloned** entries with `customName` set from the registry; it must never mutate `this.mem.entries` or the `doc` persisted by `VaultCacheStore` (VaultService.ts:204-207, 221-228). The derived `title` is untouched and remains the fallback. The vault list **cache** is therefore never polluted with custom names (overlay applied after both `listCached()` and `refresh()`), so the cache stays purely agent-derived and regenerable.

Rejected — native writes (Claude `custom-title` append, Codex `session_index.jsonl` append, OpenCode `UPDATE session.title`): triples the code, is per-format fragile, risks clobbering/locking agent-owned stores (esp. OpenCode WAL DB while `opencode` runs), and contradicts the standing metadata-only/read-only posture from `add-ai-coding-vault`. Deferred to a future opt-in.

### D2: Thread `gitBranch` through readers into the entry (Claude/Codex only)

Both readers already extract the branch but drop it: Claude parses `gitBranch` into `ClaudeFileFields` (claudeReader.ts:70-160); Codex `SELECT` already includes `git_branch` (codexReader.ts:44-46) but `mapThreadRow` discards it. Add an optional `gitBranch?: string` to `VaultSessionEntry` and stop dropping it. OpenCode records no branch → leave `undefined` (chip omitted). No git shell-out, no derivation.

### D3: Attach per-message model + tokens at the detail emit sites

Add `model?: string` and `tokens?: VaultMessageTokens` to the `message` variant of `VaultTimelineItem`. Populate them at the three existing assistant-message emit sites (Claude detail.ts:630-635, Codex codexReader.ts:828, OpenCode opencodeReader.ts:442), where the model + usage are already in scope but currently only aggregated into `stats.tokenCount`. Aggregation stays; per-message values are additive. User messages carry neither.

### D4: Auto-refresh = change-aware watcher → debounced `refresh()` → push list

**The existing `WatcherPool.subscribe` cannot be reused as-is**: it creates `RelativePattern(absPath, "*")` with `ignoreChange: true` and only reacts to create/delete (fsWatcherPool.ts:160-162, 211-214). Vault sessions grow by *appending* to existing JSONL files and by SQLite WAL writes — both are pure change events the current pool discards. So we first add a change-aware subscription (task 1_3): either extend the pool with `subscribePattern(baseDir, glob, { create, change, delete })` (a watcher built with `ignoreChange:false`) or add a small dedicated `VaultStoreWatcher`. VS Code's installed API *can* watch absolute paths outside the workspace via `new vscode.RelativePattern(vscode.Uri.file(absDir), glob)` (@types/vscode index.d.ts:13932-13945); recursive watchers may be filtered by `files.watcherExclude`, so keep patterns scoped to store roots.

Concrete watch targets (create+change+delete):
- Claude: base `~/.claude/projects`, glob `**/*.jsonl` (+ `**/sessions-index.json`).
- Codex: `~/.codex/state_5.sqlite` + `state_5.sqlite-wal`; fallback base `~/.codex/sessions`, glob `**/*.jsonl`.
- OpenCode: `~/.local/share/opencode/opencode.db` + `opencode.db-wal`.

On any event the host schedules a coalesced trailing `VaultService.refresh()` (its own single-flight prevents concurrent rescans) and posts the fresh `VaultSessionsResponseMessage` (through the existing `_vaultRefreshSeq` so stale responses drop). Subscriptions are owned by the vault feature and disposed with the view. The webview merges the pushed list in place (preserve scroll + selection; do not touch an open preview).

### D5: Live-follow = watch active session file, re-fetch bounded detail, tail-diff, then scroll or pill

The webview tells the host which session is open via `vaultWatchSession { entryId | null }`. The host subscribes (change-aware, task 1_3) to that session's file (Claude/Codex JSONL) or store DB (OpenCode `.db`+`-wal`), and on change re-runs the existing bounded `getDetail(entryId)`, pushing a `VaultSessionDetailResponseMessage` with `followUpdate: true`.

**Change detection uses a tail fingerprint, not length/timestamp.** Timeline timestamps are optional (types.ts:167-169) and a bounded tail window can change content at the same length, so `PreviewController` computes a fingerprint over the last K timeline items (`kind|role|timestamp|text-prefix`); if unchanged it no-ops. **The `followUpdate` path is handled BEFORE the normal open-detail branch** (which unconditionally scrolls to bottom, PreviewController.ts:300-303) — a follow update must never force a scroll. If changed: when scroll is at/near bottom (threshold px, captured before render) it re-renders + restores to bottom (auto-scroll); otherwise it preserves scrollTop and shows a "N new messages" pill (count = new tail items since last at-bottom). Switching/closing the preview posts `vaultWatchSession { entryId: null }` to release the watcher (at most one follow watcher active).

Rejected — byte-offset incremental tail: new per-agent parsing path, doesn't fit OpenCode SQLite, more edge cases; the bounded debounced re-read reuses all existing parsing at bounded cost. The correctness risk is *detection*, addressed by the tail fingerprint above.

### D6: "Context" means token usage; context-window only when the agent records it

There is no universal context-window field (Claude/OpenCode omit it; Codex has `model_context_window`). "Context" is rendered as token usage — prompt/context tokens (input + cache) and output tokens — with the context window shown only for Codex. No value is invented when absent (see spec: omit meta line).

## Interfaces

```ts
// src/vault/types.ts — additive
interface VaultSessionEntry {
  // ...existing fields
  gitBranch?: string;   // D2 — Claude/Codex; undefined for OpenCode
  customName?: string;  // D1 — serve-time overlay from registry; NOT persisted in vault-cache
}

interface VaultMessageTokens {
  input?: number;         // prompt/context tokens (input + cache read/creation)
  output?: number;
  contextWindow?: number; // D6 — Codex only
}

// message variant of VaultTimelineItem gains:
//   model?: string; tokens?: VaultMessageTokens;

// src/vault/VaultCustomNameRegistry.ts (new) — mirrors CustomNameRegistry
class VaultCustomNameRegistry {
  constructor(memento: vscode.Memento);
  get(entryId: string): string | undefined;
  set(entryId: string, name: string): void; // normalize (trim + cap); empty => delete
  all(): Readonly<Record<string, string>>;
}

// src/vault/VaultService.ts — injected registry + service-level API
//   constructor(..., customNames: VaultCustomNameRegistry)
//   setCustomName(entryId: string, name: string): void   // -> registry.set
//   private overlayCustomNames(entries): VaultSessionEntry[]  // clones, never mutates cache/mem
```

```ts
// src/providers/fsWatcherPool.ts — add change-aware subscription (D4/D5)
interface WatcherPool {
  // ...existing subscribe(absPath, onInvalidate)
  subscribePattern(
    baseDir: string,
    glob: string,
    on: { create?: () => void; change?: () => void; delete?: () => void },
  ): vscode.Disposable; // built with ignoreChange:false, ignoreCreate/Delete per handlers
}
// (Alternative: a dedicated src/vault/VaultStoreWatcher.ts if extending the pool is undesirable.)
```

```ts
// src/types/messages.ts — additive
// webview -> host
interface VaultRenameSessionMessage { type: "vaultRenameSession"; entryId: string; name: string }
interface VaultWatchSessionMessage  { type: "vaultWatchSession";  entryId: string | null }
// host -> webview: reuse VaultSessionsResponseMessage (auto-refresh push) and
//   VaultSessionDetailResponseMessage with an optional `followUpdate?: boolean` for D5.
```

## Architecture

```mermaid
sequenceDiagram
  participant Store as Agent store (JSONL/SQLite)
  participant WP as WatcherPool
  participant Host as VaultService / TerminalViewProvider
  participant Reg as VaultCustomNameRegistry
  participant WV as Webview (VaultPanel / PreviewController)

  Note over WP,Host: Auto-refresh (D4)
  Store->>WP: file change
  WP-->>Host: onInvalidate (debounced)
  Host->>Host: coalesce -> refresh() (single-flight)
  Host->>Reg: overlay customName onto entries
  Host-->>WV: vaultSessionsResponse (auto)
  WV->>WV: merge list, keep scroll/selection

  Note over WV,Host: Rename (D1)
  WV->>Host: vaultRenameSession {entryId, name}
  Host->>Reg: set(entryId, name)
  Host-->>WV: vaultSessionsResponse (overlaid)

  Note over WV,Store: Live-follow (D5)
  WV->>Host: vaultWatchSession {entryId}
  Host->>WP: subscribe(session file/db)
  Store->>WP: append/change
  WP-->>Host: onInvalidate (debounced)
  Host->>Host: getDetail(entryId) (bounded)
  Host-->>WV: vaultSessionDetailResponse {followUpdate:true}
  WV->>WV: diff; atBottom? append+scroll : show "N new" pill
  WV->>Host: vaultWatchSession {entryId:null} (on close/switch)
```

## Design Constraints

- The existing `WatcherPool.subscribe` ignores change events (`ignoreChange:true`, create/delete only) — it is NOT usable for vault appends/WAL. Use the new `subscribePattern` (change-aware) or a dedicated `VaultStoreWatcher`. Resolve store/session paths via existing helpers (`claudePaths`, codex/opencode path constants). Keep globs scoped to store roots — do not recursively watch all of `$HOME`; recursive patterns are subject to `files.watcherExclude`.
- OpenCode uses WAL SQLite: watch `opencode.db` (and `-wal`) and requery deltas; never tail as JSONL (already how `opencodeReader` reads).
- **Render signature must include the new fields**: `vaultRenderSignature.ts` (17-29) currently omits `customName`/`gitBranch`, and `VaultPanel` skips DOM re-render on an unchanged signature (VaultPanel.ts:580-583). Add `customName` + `gitBranch` to the signature, and render `customName ?? title` at EVERY visible-title site: `vaultListView.ts:63-66` and `PreviewController.ts:310-314`. Otherwise a rename that only changes `customName` will not re-render.
- `VaultSessionEntry.customName` must be applied (cloned) after cache load/refresh and must NOT be written into `VaultCacheStore` (keeps cache agent-derived + regenerable).
- Auto-refresh push must not race the manual path: reuse the existing monotonic `_vaultRefreshSeq` so stale/out-of-order responses are dropped.
- Live-follow `followUpdate` handling must branch before the normal open-detail scroll-to-bottom (PreviewController.ts:300-303); capture at-bottom state before re-render and restore/scroll after.

## Risk Map

| Component | Growth axis / Risk | Mitigation |
|---|---|---|
| Store watchers | Watched paths = 3 fixed store roots (not per-session); events bursty during active sessions; **must catch change events (appends/WAL), which the existing pool drops** | New change-aware `subscribePattern`/`VaultStoreWatcher` (ignoreChange:false); scope globs to store roots; 150ms debounce + coalesced trailing refresh; incremental cached `refresh()` (single-flight) — cost bounded per burst, not per event |
| Auto-refresh list push | List size grows with # sessions on disk (already bounded by reader ROW_LIMIT=500 / per-agent caps) | Reuse existing bounded readers; no new unbounded scan; merge in webview without full re-render of unchanged rows |
| Live-follow re-read | Re-parse cost per append on the previewed session only | Debounce (≥400ms), reuse bounded `getDetail` (head+tail caps already enforced), re-render only when timeline length / last timestamp changed |
| Per-message tokens on timeline | Timeline already capped at MAX_TIMELINE_ITEMS=400 | Additive optional fields; no new growth axis |
| Rename registry | One entry per renamed session in global Memento | Bounded by user actions; normalize + cap length; empty clears (no unbounded accumulation of blanks) |
| Scroll "atBottom" jitter | Re-render can shift scrollTop | Capture atBottom (threshold px) before render; restore/scroll after; pill count = messages since last-at-bottom |
