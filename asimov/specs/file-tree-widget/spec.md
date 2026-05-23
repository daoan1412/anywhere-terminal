# file-tree-widget Specification
## Requirements

### Requirement: Generic Tree<T> wrapper

The system SHALL provide a generic `Tree<T>` class in webview code that renders a hierarchical tree of items of type `T` using the vendored `listWidget` as its underlying virtualized row container, supporting expand/collapse, single selection, and keyboard navigation (Up/Down/Left/Right/Enter/Home/End).

### Requirement: Pluggable data source

The system SHALL expose an `ITreeDataSource<T>` interface that a consumer implements to feed the tree. The interface SHALL include the methods `hasChildren(element: T | null): boolean` and `getChildren(element: T | null): Promise<T[]>`, mirroring the shape of VS Code's `IAsyncDataSource` so that swapping to AsyncDataTree later requires only call-site changes.

#### Scenario: Lazy expansion

- **WHEN** a user expands a tree row whose children have not been loaded
- **THEN** the tree calls `dataSource.getChildren(element)` exactly once, displays a loading indicator on the row until the promise resolves, then renders the returned children indented one level deeper

#### Scenario: Stale async result is dropped

- **WHEN** a user collapses a row before its in-flight `getChildren` promise resolves, OR the same element is refreshed before the previous promise resolves
- **THEN** the stale resolved value SHALL be discarded and SHALL NOT update the rendered DOM; identity of the parent element SHALL determine staleness (compare by reference, not deep-equal)

### Requirement: Pluggable renderer

The system SHALL expose an `ITreeRenderer<T>` interface that a consumer implements to render a single row's DOM. The interface SHALL include `renderTemplate(container: HTMLElement): ITemplateData` and `renderElement(element: T, depth: number, template: ITemplateData): void`, with a separate `disposeTemplate` for cleanup, again mirroring VS Code's tree renderer shape.

### Requirement: Read-only API surface

The system SHALL expose only read-side operations on the Tree<T> public API in this change: `setInput(root: T)`, `expand(element: T)`, `collapse(element: T)`, `getSelection(): T | null`, `setSelection(element: T)`, `onDidChangeSelection: Event<T>`, `onDidChangeExpansion: Event<{element: T, expanded: boolean}>`, `refresh(element?: T)`. Write operations (rename, drag-drop reorder, splice) SHALL NOT be exposed in this change but the internal class structure SHALL be organized so that adding them later does NOT require renaming or reshaping existing public methods.

### Requirement: ARIA + keyboard

The system SHALL set `role="tree"` on the root container and `role="treeitem"` with correct `aria-level`, `aria-expanded`, and `aria-selected` on each row. Keyboard navigation SHALL match the WAI-ARIA Tree pattern: Right expands or moves into children; Left collapses or moves to parent; Up/Down move between visible rows; Enter activates `onDidActivate` event; Home/End jump to first/last visible row.

