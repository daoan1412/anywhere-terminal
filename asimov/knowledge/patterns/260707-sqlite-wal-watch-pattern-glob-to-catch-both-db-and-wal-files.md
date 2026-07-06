---
labels: [vscode-api, watcher, sqlite, wal, database]
source: enhance-vault-sessions
summary: VS Code watchers on SQLite databases must match both the main .db file AND its -wal (Write-Ahead Log). Use glob patterns like state_5.sqlite* or opencode.db* to catch both files. Gotcha: watching only the main file misses WAL writes during active sessions.
---
# SQLite WAL watch pattern: glob to catch both .db and -wal files
**Date**: 2026-07-07

VS Code watchers on SQLite databases must match both the main .db file AND its -wal (Write-Ahead Log). Use glob patterns like state_5.sqlite* or opencode.db* to catch both files. Gotcha: watching only the main file misses WAL writes during active sessions.
