---
labels: [xterm, terminal, link-provider, design, constraint]
source: preview-subagent-popup
summary: xterm.js ILink.range spans a single row; multi-line structures (like subagent header + trailer) must be matched on the header line alone, as the trailer is non-contiguous and unreachable from a single-row link.
---
# xterm ILink.range is single-row: match header only, not trailer
**Date**: 2026-06-01

xterm.js ILink.range spans a single row; multi-line structures (like subagent header + trailer) must be matched on the header line alone, as the trailer is non-contiguous and unreachable from a single-row link.
