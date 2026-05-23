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
 */
export interface ITreeRenderer<T, TTemplate extends ITemplateData = ITemplateData> {
  /** Unique identifier used by the underlying listWidget to cache templates by type. */
  templateId: string;

  /** Build a fresh DOM template for a row. Called once per recycled DOM row. */
  renderTemplate(container: HTMLElement): TTemplate;

  /** Bind `element` to a previously created template. Called every time the row is reused. */
  renderElement(element: T, depth: number, template: TTemplate): void;

  /** Tear down a template that is being permanently evicted from the cache. */
  disposeTemplate(template: TTemplate): void;
}
