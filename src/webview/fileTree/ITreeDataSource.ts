// src/webview/fileTree/ITreeDataSource.ts — Pluggable tree data source contract.
//
// Mirrors the shape of VS Code's `IAsyncDataSource<T>` (see vs/base/browser/ui/tree).
// Keeping the same surface means a future migration to the real AsyncDataTree
// only requires swapping the inner implementation — no consumer call-site
// renames.
//
// See: asimov/changes/port-vscode-async-data-tree/design.md D3,
//      asimov/changes/port-vscode-async-data-tree/specs/file-tree-widget/spec.md#requirement-pluggable-data-source

/**
 * Pluggable async data source for `Tree<T>`. Consumers implement this to feed
 * the tree with hierarchical data (file system, JSON document, dependency
 * graph, etc.).
 *
 * `null` represents the implicit root above the user-visible root — most
 * consumers pass the workspace-root FileNode here and only encounter `null`
 * during the very first `setInput`.
 */
export interface ITreeDataSource<T> {
  /**
   * Whether the element has any children. Called synchronously on every
   * visible row to decide whether to render the expand chevron. MUST NOT do
   * I/O — return a cached or trivially derivable boolean.
   */
  hasChildren(element: T | null): boolean;

  /**
   * Lazy-load the element's children. Called the first time a row expands.
   * The Tree caches the resolved value identity-keyed on `element` reference
   * and re-invokes only on `refresh()` or on parent-element replacement (see
   * Tree.refresh / setInput).
   *
   * Implementations should reject with `CancellationError` to signal that
   * the request was abandoned (e.g. workspace root changed mid-flight).
   */
  getChildren(element: T | null): Promise<T[]>;
}
