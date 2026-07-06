---
labels: [vscode, webview, change-detection, signature, ui-state]
source: enhance-vault-sessions
summary: A no-op render guard compares signatures before repainting. If a new field affects UI display (customName, gitBranch chip, custom flags), it MUST be added to the signature or changes will silently skip rendering. Common gotcha: rename-only changes that leave title untouched are missed.
---
# VSCode webview render signature must cover ALL UI-visible fields
**Date**: 2026-07-07

A no-op render guard compares signatures before repainting. If a new field affects UI display (customName, gitBranch chip, custom flags), it MUST be added to the signature or changes will silently skip rendering. Common gotcha: rename-only changes that leave title untouched are missed.
