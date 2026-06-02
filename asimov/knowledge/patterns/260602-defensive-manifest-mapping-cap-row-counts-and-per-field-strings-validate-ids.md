---
labels: [defensive, validation, manifest, data-handling, bounds]
source: 260602-0408-render-vault-workflow-board
summary: When building UI from untrusted manifest files (bounded only by file-size cap), defensively cap both row counts AND per-field string lengths, validate all IDs before using them in paths, and fall back to file mtime for missing timestamps so time-sensitive sorting doesn't drop data.
---
# Defensive manifest mapping — cap row counts AND per-field strings, validate IDs, use mtime fallback
**Date**: 2026-06-02

## TL;DR
- Cap **row counts** (MAX_BOARD_PHASES, MAX_BOARD_AGENTS) to prevent unbounded IPC payloads
- Cap **per-field strings** (label, title, detail, model) via `truncate()` to prevent multi-hundred-KB payloads in one field
- Validate **IDs before path construction** — strict regex + Set membership check
- **Fall back to mtime** when manifest lacks a timestamp, so time-dependent sorting doesn't silently drop data

## Context
Workflow board manifests are read from the user's local `~/.claude` directory (not a security boundary, but may be corrupted/hand-edited or pathologically large). The reader must handle:

1. **Pathologically large manifests** — bounded by `readManifestJson`'s 2 MiB file cap, but still ~millions of bytes
2. **Malformed per-field data** — a corrupt manifest could pack a multi-hundred-KB string into one field (label, title, model)
3. **Invalid IDs** — a malformed agentId shouldn't feed a path.join or allow path traversal
4. **Missing timestamps** — a partial/partial-written manifest may lack both `startTime` and `timestamp`, causing the board to be tail-dropped

## Evidence
### Anchors
- `src/vault/readers/claudeChildren.ts` lines 130–137 — row caps (`MAX_BOARD_PHASES=100, MAX_BOARD_AGENTS=500`)
- Lines 154–174 — per-field `truncate()` on all strings: label, title, detail, model, status, workflowName
- Lines 196–197 — agentId validation: `/^[A-Za-z0-9]+$/.test(agentId)` before constructing stem
- Lines 199 — stemSet membership check: `stemSet.has(stem)` before allowing drill-down entryId
- Lines 267–270 — mtime fallback for boards lacking manifest timestamp:
  ```typescript
  if (board.timestamp === undefined) {
    try {
      board.timestamp = (await fs.stat(path.join(wfDir, name))).mtimeMs;
    }
  ```
- Code review round 3, findings W1, W2, W3 — all defensive-only, corrupt-manifest-only, but fixed
- Test suite: 2049 unit tests cover normal happy-path manifests; defensive caps verified not to impact real CLI-produced data

### Excerpts
The flow:
1. Read manifest (`readManifestJson` — best-effort, returns null on parse error; 2 MiB cap)
2. Build board item:
   - Pre-scan explicit phase indices (collision-free synthesis)
   - Loop `workflowProgress` entries, capping at `MAX_BOARD_PHASES` / `MAX_BOARD_AGENTS`
   - For each phase: extract title, validate it's a string, **truncate** it
   - For each agent: validate agentId regex, check file exists via stemSet, **truncate** label/title/model
   - Extract scalars (tokens, duration, tool calls) — bound by number finitude check
   - For timestamp: try `startTime`, fall back to `timestamp`, fall back to **file mtime**
3. Emit the capped + truncated board item over IPC to the webview
4. Webview builds the DOM (sync) — no further validation needed, all inputs are bounded

## When to apply
- When reading files into UI state (manifests, config, user-provided JSON)
- When iterating untrusted data into DOM nodes (could be O(n) sync work)
- When using data as a key for identity/grouping (collision detection)
- When data drives filesystem operations (path construction, directory reading)

## Prevention gate
- **Before reading:** establish the file-size cap; if cap is >10 KB, require downstream validation per field
- **Before iteration:** cap row counts AND per-entry string lengths
- **Before ID use:** validate format (alphanumeric/special-char whitelist), check membership in a pre-computed Set
- **Before time-based sorting:** provide a fallback timestamp source (mtime, read-time) so no data is silently dropped
- **Document the caps:** why they exist, what realistic inputs look like ("~tens of agents, ~KB per field")

