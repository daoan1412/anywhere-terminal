// src/webview/fileTree/ITreeRenderer.ts — Pluggable tree row renderer contract.
//
// Mirrors the shape of VS Code's `ITreeRenderer<T, TFilterData, TTemplate>`
// (see vs/base/browser/ui/list/list.IListRenderer + vs/base/browser/ui/tree).
// Keeping the same surface means a future migration to the real AsyncDataTree
// only requires swapping the inner implementation — no consumer call-site
// renames.
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D3,
//      asimov/changes/port-vscode-async-data-tree/specs/file-tree-widget/spec.md#requirement-pluggable-renderer

/**
 * Opaque per-row template handle. Renderers may extend this with any DOM
 * references they need to re-use across `renderElement` calls; the Tree
 * itself only ever sees the type-erased `ITemplateData` shape.
 */
export interface ITemplateData {
  /** Optional teardown hook for any owned resources. Called from `disposeTemplate`. */
  dispose?(): void;
}

/**
 * Pluggable per-row renderer. The Tree calls `renderTemplate` once per
 * recycled DOM row (creating it as needed) and `renderElement` every time
 * that row is reused for a new element. `disposeTemplate` is called when the
 * row is permanently removed from the cache.
 *
 * `depth` is the 0-based indentation level — root rows are depth 0.
 *
 * `matchData` (optional) carries per-row fuzzy-match metadata produced by
 * flat-list builders. Renderers that don't care about highlighting can ignore
 * the argument. See: add-file-tree-search design D7.
 */
export interface ITreeRenderer<T, TTemplate extends ITemplateData = ITemplateData> {
  /** Unique identifier used by the underlying listWidget to cache templates by type. */
  templateId: string;

  /** Build a fresh DOM template for a row. Called once per recycled DOM row. */
  renderTemplate(container: HTMLElement): TTemplate;

  /** Bind `element` to a previously created template. Called every time the row is reused. */
  renderElement(element: T, depth: number, template: TTemplate, matchData?: ITreeMatchData): void;

  /** Tear down a template that is being permanently evicted from the cache. */
  disposeTemplate(template: TTemplate): void;
}

/**
 * A single matched range produced by a fuzzy/substring matcher. End is
 * exclusive (matches the VSCode `filters.ts` convention so the adapter in
 * `search/matching.ts` can map `createMatches()` output directly).
 */
export interface ITreeMatch {
  readonly start: number;
  readonly end: number;
}

/**
 * Per-row match metadata passed through to `renderElement`. The renderer is
 * responsible for wrapping the `matches` ranges in highlight spans. Owned by
 * this module (instead of `Tree.ts`) so consumers implementing
 * `ITreeRenderer` don't need to pull in the Tree class itself; `Tree.ts`
 * re-exports the same type as `IMatchData` for backwards compatibility.
 */
export interface ITreeMatchData {
  readonly matches: ReadonlyArray<ITreeMatch>;
  readonly score: number;
}
