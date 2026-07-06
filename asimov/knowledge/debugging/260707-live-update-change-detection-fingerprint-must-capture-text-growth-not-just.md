---
labels: [change-detection, streaming, update-detection, fingerprint]
source: enhance-vault-sessions
summary: When detecting changes to append new items in a live-update (e.g., streaming message preview), a fingerprint of timeline length alone misses in-place text growth. Include text length + prefix + suffix slices so a message assembled across multiple re-reads still triggers a re-render.
---
# Live-update change detection: fingerprint must capture text growth, not just length
**Date**: 2026-07-07

When detecting changes to append new items in a live-update (e.g., streaming message preview), a fingerprint of timeline length alone misses in-place text growth. Include text length + prefix + suffix slices so a message assembled across multiple re-reads still triggers a re-render.
