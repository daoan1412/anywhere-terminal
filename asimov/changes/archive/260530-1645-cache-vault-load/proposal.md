# Proposal: cache-vault-load

## Why

The AI Vault panel re-scans every agent session store on every VS Code open before it can display
anything — dominated by reading the last 64 KB of every Claude `.jsonl` file. Users wait noticeably each
time. Caching the session list and refreshing only changed sources makes the panel display instantly and
keeps background work proportional to what actually changed.

## Appetite

M (≤3d) — focused but full: a cache store, incremental paths in three readers, service orchestration,
two-phase host response, a webview render guard, and tests. Care required (privacy posture + correctness).

## Scope

### In scope
- Persistent host-side cache of the aggregated session **list** (`VaultListResult` + per-agent freshness state).
- Instant cached render on open, followed by an incremental background refresh ("stale-while-revalidate").
- Incremental refresh: re-read only sources whose backing files changed (Claude per session file; Codex/OpenCode per DB file).
- Webview no-op render guard so an unchanged refresh causes no flicker / no disruption.
- MODIFY two specs (host cache allowed; bounded title may be cached at rest under `0o600`, local-only).

### Out of scope
- Session **detail**/transcript caching — already on-demand & bounded; not part of cold-open latency.
- Changing what metadata is extracted, the fork/resume/launch flows, or detail readers.
- A live filesystem watcher / push-refresh (refresh stays request-driven on open).
- Cross-machine sync or any egress of vault data (explicitly preserved as forbidden).

## Capabilities

1. **vault-list-cache** — Persist the session list and serve it instantly on open, then incrementally refresh only changed sources.

## UI Impact & E2E

- **User-visible UI behavior affected?** YES — the vault list appears instantly from cache on open; an
  unchanged refresh is invisible (no re-render), a changed refresh updates the list in place.
- **E2E required?** NOT REQUIRED — project has no E2E harness (`project.md` § Commands: E2E = N/A). Covered
  by Vitest unit tests (cache store round-trip/corruption, per-reader incremental reuse, service
  two-phase + single-flight, webview signature guard).
- **Justification**: Logic is unit-testable behind the existing reader/dep-injection and `FsLike` seams;
  no integration harness exists to add this to.

## Risk Level

MEDIUM — persists potentially-sensitive titles at rest (mitigated `0o600` local-only, mirroring
`SessionStorage`) and introduces cache-staleness/invalidation that must reconcile additions, edits, and
deletions correctly.
