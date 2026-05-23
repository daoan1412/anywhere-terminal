## ADDED Requirements

### Requirement: Vendored fuzzyScore subset

The system SHALL vendor a minimal subset of `vs/base/common/filters.ts` from `microsoft/vscode` into `src/vendor/vscode/vs/base/common/filters.ts`, containing AT LEAST the exported symbols `fuzzyScore`, `FuzzyScore`, `FuzzyScoreOptions`, `createMatches`, `IMatch`, and the internal helpers required for `fuzzyScore` to compile (DP scoring tables, character-class detection, backtracking). Symbols not transitively required by these exports SHALL be removed from the vendored copy.

### Requirement: Manifest entries for new vendored files

The system SHALL append entries for each new vendored file to `src/vendor/vscode/MANIFEST.json` with `upstreamPath`, `upstreamSha`, and `copyTimestamp`. The upstream SHA SHALL be the same commit used by the existing `vscode-list-widget-vendor` entries unless the user explicitly approves bumping the vendor SHA.

### Requirement: License attribution preserved

The system SHALL preserve the original Microsoft copyright header at the top of every newly vendored file unchanged. No new entries to `THIRD_PARTY_NOTICES.md` are required because the upstream repository, license text, and SHA are already attributed there by the prior vendor change.

### Requirement: Biome ignores apply to new files

The system SHALL ensure the existing `biome.json` `files.includes` exclusion of `src/vendor/**` continues to cover the newly vendored files. The build SHALL pass `pnpm run lint` AND `pnpm run format` without flagging vendored sources.

### Requirement: Bundle delta budget measured at vendor-time

The system SHALL keep the post-vendor `media/webview.js` production bundle below the existing 3.6 MB ceiling enforced by `scripts/check-bundle-size.mjs`. The measured delta from this change alone SHALL NOT exceed 50 KB. The delta SHALL be measured IMMEDIATELY after the vendor commit AND before any consumer code is written; exceeding either constraint requires explicit re-scoping.

### Requirement: Unit test for fuzzyScore parity

The system SHALL include a Vitest unit test that asserts `fuzzyScore` returns non-null for at least these golden cases against representative paths: query `"fp"` against `"src/webview/fileTree/FileTreePanel.ts"` and query `"ftp"` against the same path; AND that ranking orders `"FileTreePanel.ts"` ABOVE `"file-tree-panel.test.ts"` for the query `"fp"`. The test SHALL also verify `createMatches` returns ranges whose total character count equals the query length for an exact-prefix match.

### Requirement: NLS stub coverage unchanged

The system SHALL reuse the existing `vs/nls.ts` stub introduced by `vscode-list-widget-vendor`. No new localization keys SHALL be added to the stub for this change.
