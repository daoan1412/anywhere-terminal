# vscode-list-widget-vendor Specification
## Requirements

### Requirement: Vendored VS Code list widget

The system SHALL vendor the source files of `vs/base/browser/ui/list/` (listWidget, listView, listPaging, list, rangeMap, rowCache, splice) plus their minimum-required transitive `vs/base/browser/` and `vs/base/common/` dependencies into `src/vendor/vscode/` so that listWidget can be instantiated from webview code without referencing the upstream `microsoft/vscode` repository at build time.

### Requirement: Path alias for vendored imports

The system SHALL resolve `vs/*` import specifiers to `src/vendor/vscode/*` via matching configuration in ALL of: `tsconfig.json` (`paths`), `esbuild.js` (`alias`), and `vitest.config.mts` (`test.alias`). Type-check, bundle, AND unit-test runs SHALL agree on the same resolution. Any divergence between configs SHALL produce a build or test error rather than silently shipping broken code.

#### Scenario: Vendored file referenced from a vitest unit test

- **WHEN** `import { List } from 'vs/base/browser/ui/list/listWidget'` appears in a `*.test.ts`
- **THEN** Vitest resolves the import using the alias and the test executes without `Cannot find module` errors

### Requirement: Biome ignores vendored sources

The system SHALL exclude `src/vendor/**` from Biome's lint and format rules via `biome.json` `files.includes`. Vendored files SHALL NOT be reformatted by `pnpm run format` or flagged by `pnpm run lint`.

### Requirement: License attribution

The system SHALL preserve the original Microsoft copyright header at the top of every vendored file unchanged, AND SHALL include a top-level `THIRD_PARTY_NOTICES.md` containing the verbatim MIT license text, the upstream repository name (`microsoft/vscode`), and the commit SHA from which the files were copied.

### Requirement: Vendor manifest

The system SHALL produce `src/vendor/vscode/MANIFEST.json` listing every vendored file with its upstream path, upstream SHA, and copy timestamp. The vendoring tooling SHALL support a dry-run mode that prints the resolved closure (including side-effect CSS imports such as `import './list.css'` and relative `.js` extension imports such as `../../dom.js`) without touching the filesystem.

### Requirement: NLS localization stub

The system SHALL provide a stub for `vs/nls.ts` exposing `localize(key, defaultValue, ...args)` AND `localize2(key, defaultValue, ...args)` functions that return values matching upstream signatures after positional argument substitution, so that vendored files calling `nls.localize(...)` or `nls.localize2(...)` produce English strings without requiring VS Code's NLS infrastructure.

### Requirement: Build smoke after vendoring

The system SHALL pass `pnpm run check-types`, `pnpm run test:unit`, AND produce a successful production bundle (`node esbuild.js --production`) after the vendor phase, before any consumer code (Tree<T>, FileTreePanel) is wired in.

### Requirement: Bundle size budget

The system SHALL keep `media/webview.js` production bundle below the ceiling enforced by `scripts/check-bundle-size.mjs`. The ceiling SHALL be raised to **3.6 MB** in this change. The actual post-vendor delta SHALL be measured against the pre-vendor baseline and SHALL NOT exceed 450 KB; exceeding either constraint requires explicit re-scoping.

