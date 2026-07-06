# Tasks: enhance-vault-sessions

## 1. Host foundation — data model + rename registry

- [x] 1_1 Extend vault types with branch, custom name, and per-message metadata
  - **Deps**: none
  - **Refs**: design.md D1, D2, D3; specs/vault-metadata-display/spec.md#requirement-per-assistant-message-model-and-token-usage; specs/vault-session-rename/spec.md#requirement-custom-name-overrides-derived-title
  - **Scope**: src/vault/types.ts
  - **Acceptance**:
    - Outcome: `VaultSessionEntry` has optional `gitBranch?: string` and `customName?: string`; a `VaultMessageTokens` type exists; the `message` variant of `VaultTimelineItem` has optional `model?: string` and `tokens?: VaultMessageTokens`.
    - Verify: manual `pnpm run check-types` passes
  - **Plan**:
    1. Add `gitBranch?`, `customName?` to `VaultSessionEntry` (types.ts:122-151).
    2. Add `interface VaultMessageTokens { input?; output?; contextWindow? }`.
    3. Add `model?`/`tokens?` to the `message` timeline variant (types.ts:168).

- [x] 1_2 Create VaultCustomNameRegistry (Memento-backed, normalize + clear)
  - **Deps**: none
  - **Refs**: design.md D1; specs/vault-session-rename/spec.md#requirement-name-normalization-and-clearing; src/session/CustomNameRegistry.ts (template)
  - **Scope**: src/vault/VaultCustomNameRegistry.ts, src/vault/VaultCustomNameRegistry.test.ts
  - **Acceptance**:
    - Outcome: `get/set/all` persist via injected `Memento`; `set` trims + caps length (same MAX as terminal rename) and deletes the key when the trimmed name is empty.
    - Verify: unit src/vault/VaultCustomNameRegistry.test.ts
  - **Plan**:
    1. Mirror `CustomNameRegistry` shape but key by `entryId` string.
    2. Reuse the same normalization (trim + max length) as `CustomNameRegistry`.
    3. Test set→get, empty→clear, over-length cap, all() snapshot.

- [x] 1_3 Add change-aware pattern subscription to the FS watcher
  - **Deps**: none
  - **Refs**: design.md D4, D5; specs/vault-auto-refresh/spec.md; src/providers/fsWatcherPool.ts:65-89,160-162,211-214
  - **Scope**: src/providers/fsWatcherPool.ts
  - **Acceptance**:
    - Outcome: a `subscribePattern(baseDir, glob, { create?, change?, delete? })` (built with `ignoreChange:false`) fires the `change` handler on appends to existing files and on WAL writes, returning a `Disposable`; the existing `subscribe` is unchanged.
    - Verify: manual watch a growing `.jsonl` → change handler fires on append (not just create)
  - **Plan**:
    1. Add `subscribePattern` creating a `FileSystemWatcher` over `new vscode.RelativePattern(Uri.file(baseDir), glob)` with `ignoreCreate/Change/Delete` derived from which handlers are passed.
    2. Keep the 150ms debounce + refcount; wire onDidChange/onDidCreate/onDidDelete to the handlers.

## 2. Host — readers thread metadata

- [x] 2_1 Claude reader: keep branch on entry + attach per-message model/tokens in detail
  - **Deps**: 1_1
  - **Refs**: design.md D2, D3; docs/research/20260707-vault-session-formats.md; specs/vault-metadata-display/spec.md
  - **Scope**: src/vault/readers/claudeReader.ts, src/vault/readers/detail.ts, src/vault/readers/claudeReader.detail.test.ts
  - **Acceptance**:
    - Outcome: Claude list entries carry `gitBranch` from `ClaudeFileFields`; assistant `message` timeline items carry `model` (from `message.model`) and `tokens` (`input` = input+cache read/creation, `output` = output_tokens); user messages carry neither.
    - Verify: unit src/vault/readers/claudeReader.detail.test.ts
  - **Plan**:
    1. Set `gitBranch` on the entry in `parseClaudeFile` (already parsed at claudeReader.ts:127-160).
    2. At the assistant emit site in `classifyClaudeStyleEvents` (detail.ts:630-635), read `message.model` + `message.usage` and set `model`/`tokens` on the emitted item.
    3. Extend the detail test to assert per-message model + tokens.

- [x] 2_2 Codex reader: retain git_branch on entry + attach per-message model/tokens/context-window
  - **Deps**: 1_1
  - **Refs**: design.md D2, D3, D6; docs/research/20260707-vault-session-formats.md; specs/vault-metadata-display/spec.md
  - **Scope**: src/vault/readers/codexReader.ts, src/vault/readers/codexReader.detail.test.ts
  - **Acceptance**:
    - Outcome: `mapThreadRow` sets `gitBranch` from the `git_branch` column (codexReader.ts:44-46,136-150); assistant `message` items carry `model` and `tokens` (input/output from `token_count.info.*`, `contextWindow` from `model_context_window` when present).
    - Verify: unit src/vault/readers/codexReader.detail.test.ts
  - **Plan**:
    1. Stop dropping `git_branch` in `mapThreadRow`; assign to entry `gitBranch`.
    2. At the codex message emit site (codexReader.ts:828), attach `model` + `tokens` (map `total_token_usage`/`model_context_window` per research doc).
    3. Add/extend a codex detail test asserting the new per-message fields (create the test file if absent).

- [x] 2_3 OpenCode reader: attach per-message model/tokens (branch omitted)
  - **Deps**: 1_1
  - **Refs**: design.md D3; docs/research/20260707-vault-session-formats.md; specs/vault-metadata-display/spec.md#requirement-session-git-branch-chip
  - **Scope**: src/vault/readers/opencodeReader.ts, src/vault/readers/opencodeReader.detail.test.ts
  - **Acceptance**:
    - Outcome: assistant `message` items carry `model` (`data.modelID`) and `tokens` (`data.tokens.input`+cache, `data.tokens.output`); `gitBranch` stays undefined for OpenCode entries.
    - Verify: unit src/vault/readers/opencodeReader.detail.test.ts
  - **Plan**:
    1. At the opencode message emit site (opencodeReader.ts:442), read `data.modelID` + `data.tokens` and set `model`/`tokens`.
    2. Add/extend an opencode detail test asserting per-message model+tokens and no branch.

- [x] 2_4 Inject registry into VaultService + overlay custom names (cloned, cache-safe)
  - **Deps**: 1_1, 1_2
  - **Refs**: design.md D1; specs/vault-session-rename/spec.md#requirement-custom-name-overrides-derived-title
  - **Scope**: src/vault/VaultService.ts, src/extension.ts, src/vault/VaultService.customName.test.ts
  - **Acceptance**:
    - Outcome: `VaultService` takes an injected `VaultCustomNameRegistry` (constructed in `extension.ts` with `context.globalState`) and exposes `setCustomName(entryId, name)`; both `listCached()` and `refresh()` return CLONED entries with `customName` overlaid; `this.mem.entries` and the persisted `VaultCacheStore` doc are never mutated (cache file has no custom name).
    - Verify: unit src/vault/VaultService.customName.test.ts
  - **Plan**:
    1. Add a `VaultCustomNameRegistry` constructor param; construct+inject it in `extension.ts` (service built at extension.ts:126-129).
    2. Add `setCustomName` + private `overlayCustomNames(entries)` that CLONES entries (no mutation of mem/doc), applied on the way out of `listCached()`/`refresh()`.
    3. Test: rename overlays title; served entries cloned; cache doc/mem unchanged (no customName persisted).

## 3. Host — IPC, rename handler, watchers

- [x] 3_1 Add IPC message types for rename + watch + follow-update flag
  - **Deps**: 1_1
  - **Refs**: design.md D1, D4, D5 (Interfaces); src/types/messages.ts (RenameTabMessage precedent)
  - **Scope**: src/types/messages.ts
  - **Acceptance**:
    - Outcome: `VaultRenameSessionMessage`, `VaultWatchSessionMessage` exist in the webview→host union; `VaultSessionDetailResponseMessage` gains optional `followUpdate?: boolean`; `check-types` passes.
    - Verify: manual `pnpm run check-types` passes
  - **Plan**:
    1. Add the two request message interfaces + add to the inbound union.
    2. Add optional `followUpdate?` to the detail response message.

- [x] 3_2 Host: handle vaultRenameSession → registry.set → push overlaid list
  - **Deps**: 2_4, 3_1
  - **Refs**: design.md D1; specs/vault-session-rename/spec.md; src/providers/TerminalViewProvider.ts (renameTab handler:843-847, handleRequestVaultSessions:339-383)
  - **Scope**: src/providers/TerminalViewProvider.ts
  - **Acceptance**:
    - Outcome: a `vaultRenameSession` message calls `vaultService.setCustomName(entryId, name)` then re-posts the overlaid list from `listCached()`; empty name clears and reverts the title. (Registry is already injected via 2_4 — no per-provider registry.)
    - Verify: manual rename via context menu updates row title; clearing reverts to derived title
  - **Plan**:
    1. Add a `vaultRenameSession` case → `vaultService.setCustomName(entryId, name)`.
    2. Post `vaultSessionsResponse` from `listCached()` (through `_vaultRefreshSeq`).

- [x] 3_3 Host: auto-refresh watcher over the three stores
  - **Deps**: 1_3, 2_4, 3_1
  - **Refs**: design.md D4; specs/vault-auto-refresh/spec.md; src/providers/fsWatcherPool.ts (new subscribePattern); src/vault/readers/claudePaths.ts (+ codex/opencode path resolution in their readers)
  - **Scope**: src/providers/TerminalViewProvider.ts, src/vault/VaultService.ts, src/vault/readers/codexReader.ts, src/vault/readers/opencodeReader.ts, src/vault/VaultService.watchTargets.test.ts
  - **Note (scope+)**: exported `codexStoreDirs`/`opencodeStoreDirs` from the readers (single source of truth for watch paths per design D4 constraint — `claudeRoots`/`resolveClaudeSessionPath` were already exported); watch-target resolution lives on `VaultService` (`getStoreWatchTargets` + `resolveSessionWatchTargets`, contract-tested in `VaultService.watchTargets.test.ts`).
  - **Acceptance**:
    - Outcome: while the vault view is live, create/change/delete under the concrete targets (Claude `~/.claude/projects` `**/*.jsonl`; Codex `state_5.sqlite`+`-wal` + `sessions/**/*.jsonl`; OpenCode `opencode.db`+`-wal`) trigger a debounced, coalesced `refresh()` and a `vaultSessionsResponse` push; subscriptions disposed with the view; `_vaultRefreshSeq` drops stale responses.
    - Verify: manual append to an existing session file on disk → list updates within ~1s without clicking refresh
  - **Plan**:
    1. Resolve the concrete store targets/patterns per D4 (reuse reader path helpers).
    2. `subscribePattern(base, glob, { create, change, delete })` each → shared coalescing timer → `refresh()` → post via `_vaultRefreshSeq`.
    3. Track the subscription disposables and dispose them on view dispose.

- [x] 3_4 Host: live-follow watcher for the previewed session
  - **Deps**: 3_1, 3_3
  - **Refs**: design.md D5; specs/vault-live-follow/spec.md; src/providers/fsWatcherPool.ts (subscribePattern); src/providers/TerminalViewProvider.ts (requestVaultSessionDetail handler)
  - **Scope**: src/providers/TerminalViewProvider.ts
  - **Acceptance**:
    - Outcome: `vaultWatchSession {entryId}` subscribes (via `subscribePattern`, change-aware) to that session's file (Claude/Codex JSONL) or DB (OpenCode `.db`+`-wal`); on change it re-runs `getDetail(entryId)` (debounced) and posts `vaultSessionDetailResponse {followUpdate:true}`; `vaultWatchSession {entryId:null}` and view dispose release the watcher (at most one follow watcher active).
    - Verify: manual open a preview of an active session → new messages arrive without reopening
  - **Plan**:
    1. Resolve the session file/DB path for an entryId per agent.
    2. On `vaultWatchSession`, dispose any prior follow sub, subscribe the new one, debounce → `getDetail` → post detail with `followUpdate`.
    3. On null / dispose, release the follow subscription.

## 4. Webview — rename UI, metadata display, auto-update, live-follow

- [x] 4_1 Rename UI: context-menu item + inline edit + render `customName ?? title` everywhere
  - **Deps**: 3_2
  - **Refs**: design.md D1 (Design Constraints — render signature); specs/vault-session-rename/spec.md; src/webview/vault/VaultContextMenu.ts:46-82; src/webview/vault/vaultListView.ts:63-66; src/webview/vault/VaultPanel.ts:159,580-583; src/webview/vault/vaultRenderSignature.ts:17-29; src/webview/vault/PreviewController.ts:310-314
  - **Scope**: src/webview/vault/VaultContextMenu.ts, src/webview/vault/vaultListView.ts, src/webview/vault/VaultPanel.ts, src/webview/vault/vaultRenderSignature.ts, src/webview/vault/PreviewController.ts, src/webview/vault/vaultRenderSignature.test.ts, src/webview/vault/icons.ts, src/webview/vault/VaultPanel.test.ts
  - **Scope+ Note**: added `icons.ts` (ICON_RENAME pencil) and updated `VaultPanel.test.ts` (context-menu label list gained "Rename"; postMessage mock widened to `entryId?: string | null`).
  - **Acceptance**:
    - Outcome: a "Rename" context-menu item opens an inline editor seeded with the current name; committing posts `vaultRenameSession {entryId, name}`; `vaultRenderSignature` includes `customName`+`gitBranch` so a rename-only change re-renders; every visible-title site (list row + preview header) renders `customName ?? title`.
    - Verify: unit src/webview/vault/vaultRenderSignature.test.ts
  - **Plan**:
    1. Add `customName` + `gitBranch` to `vaultRenderSignature` (so unchanged-signature short-circuit at VaultPanel.ts:580-583 doesn't skip a rename); add a test that a customName-only delta changes the signature.
    2. Add a "Rename" item to `VaultContextMenu`; add inline-edit in `vaultListView` (title element → input; Enter commits, Esc cancels; empty clears).
    3. Post `vaultRenameSession` from `VaultPanel`; render `entry.customName ?? entry.title` at `vaultListView.ts:63-66` AND `PreviewController.ts:310-314`.

- [x] 4_2 Preview: branch chip + per-message model/token meta line
  - **Deps**: 2_1, 2_2, 2_3
  - **Refs**: design.md D3, D6; specs/vault-metadata-display/spec.md; src/webview/vault/previewHeader.ts:14-15,107-112; src/webview/vault/renderAtoms.ts:17-39; src/webview/vault/previewTimeline.ts:62-145
  - **Scope**: src/webview/vault/previewHeader.ts, src/webview/vault/renderAtoms.ts, src/webview/vault/previewTimeline.ts, src/webview/vault/PreviewController.ts, src/webview/vault/vaultPanel.css
  - **Scope+ Note**: vault preview styles live in `src/webview/vault/vaultPanel.css` (bundled via src/providers/webviewHtml.ts), not `media/*.css` as originally scoped; branch chip is wired through `PreviewController.buildPreviewHeader` (shared 4_1/4_4 file).
  - **Acceptance**:
    - Outcome: preview header shows a git-branch chip when `entry.gitBranch` is set (omitted otherwise); each assistant message with `model`/`tokens` shows a compact meta line (model + input/output tokens, + context window when present); messages without data show no meta line.
    - Verify: manual open a Claude/Codex session → branch chip + per-message model/tokens visible; OpenCode → no branch chip
  - **Plan**:
    1. Add a branch chip to `previewHeader` (reuse chip styling; multi-chip if needed).
    2. In `renderAtoms.previewMessage`, render an optional meta line from `model`/`tokens`.
    3. Thread `model`/`tokens` from the timeline item through `renderTimelineInto` to `previewMessage`; add CSS for the meta line/chip.

- [x] 4_3 Webview: apply auto-refresh push without disrupting scroll/selection
  - **Deps**: 3_3
  - **Refs**: design.md D4; specs/vault-auto-refresh/spec.md#requirement-non-disruptive-auto-update; src/webview/vault/VaultPanel.ts:105-110,525
  - **Scope**: src/webview/vault/VaultPanel.ts, src/webview/vault/vaultListView.ts
  - **Acceptance**:
    - Outcome: an incoming `vaultSessionsResponse` re-renders the list preserving scroll position and current selection, and does not close/reset an open preview; the manual refresh button still works.
    - Verify: manual scroll list + open preview, trigger a disk change → list updates, scroll+selection kept, preview stays open
  - **Plan**:
    1. Capture scrollTop + selected entryId before re-render; restore after.
    2. Guard the preview: an auto list update must not call preview close/reset.

- [x] 4_4 Webview: live-follow — auto-scroll at bottom, "N new messages" pill when scrolled up
  - **Deps**: 3_4, 4_2
  - **Refs**: design.md D5; specs/vault-live-follow/spec.md; src/webview/vault/PreviewController.ts:89-230; src/webview/vault/previewScrollNav.ts:15-97; src/webview/vault/FloatingPreviewShell.ts
  - **Scope**: src/webview/vault/PreviewController.ts, src/webview/vault/previewScrollNav.ts, src/webview/vault/vaultPanel.css
  - **Scope+ Note**: FloatingPreviewShell.ts needed no change (pill is owned by previewScrollNav, already reachable via `shell.scrollNav`); styles in `src/webview/vault/vaultPanel.css` (not `media/*.css`).
  - **Acceptance**:
    - Outcome: opening a preview posts `vaultWatchSession {entryId}` and closing/switching posts `{entryId:null}`; a `followUpdate` detail is handled BEFORE the normal open-detail scroll path (PreviewController.ts:300-303) so it never force-scrolls; change is detected by a tail fingerprint (not length/timestamp); when at/near bottom → append + auto-scroll; when scrolled up → "N new messages" pill that on click scrolls to newest and clears; unchanged updates no-op.
    - Verify: manual follow an active session at bottom (auto-scrolls) and scrolled-up (pill appears, click jumps to newest)
  - **Plan**:
    1. Post `vaultWatchSession` on open/close/switch in `PreviewController`; branch `followUpdate` responses before the initial-load scroll-to-bottom.
    2. Track `atBottom` (threshold px, captured before render) on scroll; on `followUpdate` compute a tail fingerprint over the last K items (`kind|role|timestamp|text-prefix`); no-op if unchanged.
    3. At bottom → append + restore-to-bottom; scrolled up → render/update a "N new messages" pill (reuse scroll-nav FAB area) with count = new tail items since last at-bottom; click → scroll to bottom + clear.
