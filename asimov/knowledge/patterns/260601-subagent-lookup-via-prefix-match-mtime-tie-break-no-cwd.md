---
labels: [terminal, resolution, prefix-match, mtime, tie-break, readers]
source: preview-subagent-popup
summary: Resolve a subagent by its click-captured description using prefix match (terminal width clips the right edge) + stable mtime tie-break
---
# Subagent lookup via prefix match + mtime tie-break (no cwd)
**Date**: 2026-06-01

## TL;DR
- Resolve a subagent by its click-captured description using **prefix match** (terminal width clips the right edge) + stable **mtime tie-break**
- Reuse existing `listClaudeSubagentStubs(sessionId)` and `readClaudeSubagentDetail()` — no cwd needed because readers locate the parent by sessionId alone
- Deterministic tie-break: when multiple subagents match the prefix, pick the one with the newest `<sessionId>.jsonl` mtime; use lexical stem order as secondary key

## Context
When a user clicks a subagent header line in the terminal, the `SubagentLinkProvider` captures the verbatim text and the `description` field (what's inside the parentheses). However, a narrow terminal can right-edge-clip the description, so the captured text is a PREFIX of the full description on disk.

Resolution must:
1. Enumerate all subagents in the parent session
2. Prefix-match the clicked text against each subagent's `description`
3. Pick the newest when multiple match (tie-break by `<sessionId>.jsonl` mtime)
4. Never throw — if no match or read fails, return null (popup shows "not found")

Crucially, there is no `encodeProjectDir()` (only lossy decode), so we cannot reconstruct a cwd-based path. Instead, we reuse existing readers that locate the parent session by `sessionId` (which we have from session resolution).

## Evidence
### Anchors
- `src/vault/readers/subagentLookup.ts` lines 65–91 — `resolveSubagentDetail(sessionId, description)` main entry point
- `src/vault/readers/subagentLookup.ts` lines 31–57 — `pickNewestByMtime()` with stable secondary key (lexical stem)
- `src/vault/readers/subagentLookup.ts` lines 75–82 — prefix-match filter on `s.description.startsWith(clicked)`
- `src/vault/readers/claudeChildren.ts` — reused `listClaudeSubagentStubs(sessionId)` (no cwd param) and `readClaudeSubagentDetail(parentId=sessionId, stem, ...)`
- `src/vault/readers/claudePaths.ts` — `SUBAGENT_MARKER` split to recover stem from entryId

### Pattern
Prefix-match + mtime tie-break is essential when:
1. User input is a **prefix** of the authoritative value (terminal right-edge clipping)
2. Multiple records can match the same prefix (two subagents with similar names/descriptions)
3. You need **deterministic** tie-breaking independent of file-system order (use a property with defined semantics: mtime recency, then lexical order)

## When to apply
- Matching user-entered or clipped text against on-disk descriptions
- Any situation where `s.description.startsWith(userInput)` is the match criterion
- Especially when one on-disk source can be modified/re-run and its mtime changes (prefer newer = more recent activity)

## Prevention gate
- Always include a **secondary tie-break key** (lexical field) when using mtime — file-system readdir order is non-deterministic
- Test with fixtures that have equal or very close mtimes to verify secondary key works
- Log/assert that picked == chosen for debugging (when mtime tie-break is used)
