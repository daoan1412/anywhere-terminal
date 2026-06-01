---
labels: [terminal, session, process-tree, resolution, architecture]
source: preview-subagent-popup
summary: Map a terminal pane to its running Claude session via process-tree walk (pty descendants) intersected with PID registry, with stable tie-breaking by mtime and cwd/newest-session fallbacks.
---
# Terminal→Claude session resolution chain: process-tree + PID registry + cwd fallback
**Date**: 2026-06-01

Map a terminal pane to its running Claude session via process-tree walk (pty descendants) intersected with PID registry, with stable tie-breaking by mtime and cwd/newest-session fallbacks.
