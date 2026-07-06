---
labels: [vscode-api, custom-name, memento, overlay, defensive]
source: enhance-vault-sessions
summary: VaultCustomNameRegistry applies user-supplied custom names as a serve-time overlay from VSCode Memento, never writes back to agent files. Pattern reusable for any UI feature that needs to safely augment agent-owned data.
---
# Sidecar read-only registry overlay pattern: custom names without mutating agent stores
**Date**: 2026-07-07

VaultCustomNameRegistry applies user-supplied custom names as a serve-time overlay from VSCode Memento, never writes back to agent files. Pattern reusable for any UI feature that needs to safely augment agent-owned data.
