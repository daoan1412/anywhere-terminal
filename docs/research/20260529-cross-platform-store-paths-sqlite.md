---
topic: cross-platform-store-paths-sqlite
created-by: research for a VS Code AI session vault on Claude Code storage and SQLite readers
date: 2026-05-29
libraries: [claude-code, node:sqlite, sql.js, sqlite-wasm, better-sqlite3]
used-by: []
---

# Research: cross-platform-store-paths-sqlite

## PART A
- **Windows base dir:** yes — Claude Code’s `~/.claude` resolves to `%USERPROFILE%\.claude` on Windows. The docs also say `CLAUDE_CONFIG_DIR` relocates the whole `~/.claude` tree; I found no official `XDG_CONFIG_HOME` or `CLAUDE_HOME` override mention.
- **Project dir encoding:** session transcripts live at `~/.claude/projects/<encoded-cwd>/*.jsonl`; the docs say the cwd is encoded by replacing every non-alphanumeric character with `-`. That encoding is lossy on Windows (`C:\...` collapses to hyphen runs), so decoding directory names is not reversible/reliable; treat the dir name as opaque and prefer the `cwd` inside the JSONL.
- **JSONL schema on Windows:** I found no documented Windows-specific schema differences for the transcript lines. The `cwd`/summary fields appear to be the same cross-platform, but I could not verify a Windows-only schema delta.

## PART B
- **`node:sqlite` (built-in):** introduced in Node `v22.5.0`; `--experimental-sqlite` was removed in `v22.13.0` / `v23.4.0`; current docs show `Stability: 1.2 (Release candidate)`. It opens a real file read-only via `new DatabaseSync(path, { readOnly: true })`, so it is the lowest-risk no-native-build path **if** your VS Code baseline is new enough. VS Code `1.101` ships Electron `35` / Node `22.15.1` (usable); VS Code `1.98` ships Electron `34` / Node `20.18.2` (too old).
- **`sql.js` (WASM):** pure JS/WASM, cross-platform, and can open an existing DB from a `Uint8Array`/`Buffer`. It avoids native builds and works well in extension hosts, but it loads the whole DB into memory and the official README recommends native SQLite for Electron/Node apps. WAL is the main gotcha: a buffer read only sees the main file, so you must checkpoint before copying if WAL changes matter.
- **`@sqlite.org/sqlite-wasm`:** official WASM wrapper, but Node support is for in-memory/no-persistence use; OPFS persistence is worker/browser-only. Not a fit for reading an on-disk DB in a Node extension host.
- **`better-sqlite3`:** fast, but native. Electron use depends on ABI-matched prebuilds or rebuild tooling (`electron-builder install-app-deps` / `electron-rebuild`), so it is the wrong choice for a zero-native-build distributed extension.

**Recommendation:** choose `sql.js` for the broadest cross-platform distribution; choose `node:sqlite` only if you can require VS Code `1.101+` / Node `22.13+`.

### Sources
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/settings
- https://platform.claude.com/docs/en/agent-sdk/sessions
- https://github.com/anthropics/claude-code/issues/16103
- https://nodejs.org/api/sqlite.html
- https://code.visualstudio.com/updates/v1_101
- https://code.visualstudio.com/updates/v1_98
- https://github.com/sql-js/sql.js/blob/master/README.md
- https://github.com/sqlite/sqlite-wasm
- https://github.com/WiseLibs/better-sqlite3

Persisted to: /Users/huybuidac/Projects/ai-oss/anywhere-terminal/docs/research/20260529-cross-platform-store-paths-sqlite.md