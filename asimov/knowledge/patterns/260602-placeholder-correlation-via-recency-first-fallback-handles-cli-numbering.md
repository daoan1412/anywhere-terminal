---
labels: [webview, clipboard, placeholder, correlation, heuristic, cli-integration]
source: preview-pasted-images
summary: When CLI numbering schemes diverge (Claude counts text+image together, OpenCode/Codex reset per prompt), resolve [Image N] placeholders via: sole-image → exact match at position N → most-recent → null. Exact for single-image case, graceful degradation for multi-image/renumber.
---
# Placeholder correlation via recency-first fallback handles CLI numbering divergence
**Date**: 2026-06-02

## TL;DR
- Claude CLI counter: monotonic session-wide, shared with text pastes (Image #1, #2, #3 for 'image, text, image')
- OpenCode: per-prompt counter (Image 1, 2, 3 for the prompt's images; resets for next prompt)
- Codex: per-prompt contiguous index, renumbers on deletion
- No universal "N" means we can't just store by index
- Solution (PastedImageStore.resolve): sole → exact → recency → null
- Exact for dominant flow (paste one image, hover immediately)
- Degrades predictably for multi-image or cross-CLI

## Context
When a user pastes an image, the CLI renders a placeholder like `[Image #N]` or `[Image N]` and reads the image from the OS clipboard. The webview also captures the blob at paste time and stores it in a per-terminal cache with a 1-based index.

The challenge: the placeholder's N doesn't reliably map to our cache index because the numbering schemes differ. The implementation needs a heuristic that works across all three CLIs.

## Evidence
### Anchors
- `src/webview/links/PastedImageStore.ts` → `resolve(n: number)` (L45-52)
  - Single image: return it (exact)
  - Position `n` exists: return `this.images[n - 1]` (exact match attempt)
  - Fallback: return most-recent `this.images[this.images.length - 1]`
  - Empty cache: return null

### Design Rationale (D3)
From discovery §1: Claude shares its counter with text pastes; OpenCode/Codex reset and renumber. Rejected options:
- Parallel monotonic counter (drifts when Claude counts text)
- Read CLI's on-disk caches by N (Claude-only, cross-boundary fs, session discovery)

Accepted: recency-first rule because:
- Dominant case (paste one image, hover it immediately) is exact
- Multi-image paste then hover each: often correct by position
- Cross-prompt on OpenCode: most-recent is reasonable guess
- When totally wrong: user pastes image, we show something; wrong is still better than nothing

## When to apply
- Mapping external identifiers (from a third-party tool) to local cached items
- The identifier scheme is unreliable or changes per context
- You need a heuristic that works across contexts, not a perfect mapping
- The cost of being wrong is low (show wrong item) vs. the cost of failure (show nothing)

Examples:
- File name: exact match first, then fuzzy match, then most-recent edit
- Line number: exact match first, then closest line, then start of file
- Placeholder index: exact position first, then most-recent item

## Prevention gate
- Document the heuristic clearly (not obvious why sole → exact → recent)
- Add unit tests for each fallback step (sole image, exact match, recency, empty cache)
- Consider how the heuristic degrades under adversarial input (wrong N, many images, numbering resets)
- For high-value mappings (file trust policy, security decisions), use exact matching only; avoid fallback heuristics

