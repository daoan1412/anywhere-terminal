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

### Requirement: setFilter method on Tree<T>

The system SHALL expose `setFilter(filter: ITreeFilter<T> | null): void` on the `Tree<T>` public API. The filter SHALL be applied during row rebuilding (`rebuildRows()`); when `filter` is non-null, rows whose elements do NOT pass `filter.shouldRender(element)` SHALL be omitted from the rendered flat list. When `filter` is null, all rows SHALL render as before. Filter changes SHALL trigger a `refresh()` of all currently visible elements.

### Requirement: ITreeFilter interface

The system SHALL expose an `ITreeFilter<T>` interface with at minimum `shouldRender(element: T): boolean` and an optional `matchData(element: T): IMatchData | undefined` method returning ranges of matched characters in the element's display label. The interface SHALL be exported alongside `ITreeDataSource<T>` and `ITreeRenderer<T>` from the same module.

### Requirement: Renderer receives match data

The system SHALL extend `ITreeRenderer<T>.renderElement` to accept an additional optional argument `matchData?: IMatchData`. When the active filter exposes `matchData(element)` returning non-undefined, the value SHALL be passed to `renderElement`; renderers that do not consume the parameter SHALL be unaffected.

### Requirement: Flat-list display mode

The system SHALL expose `setFlatItems(items: T[] | null): void` on `Tree<T>`. When `items` is non-null, the tree SHALL bypass its normal hierarchical layout and render the given array as a flat list (no indentation, no chevrons), preserving virtualization through the underlying list widget. When `items` is null, normal tree rendering SHALL resume from the last `setInput(root)`.

#### Scenario: Flat-list does not corrupt prior tree state

- **WHEN** `setFlatItems(items)` is called, then later `setFlatItems(null)` is called
- **THEN** the tree resumes rendering the previous root with its prior expansion set and selection unchanged; `getSelection()` still returns the same value it returned before `setFlatItems` was first called

### Requirement: Filter mutual exclusion with flat-list

The system SHALL treat `setFilter` and `setFlatItems` as orthogonal: setting flat items SHALL bypass the filter (the flat array is rendered as-is, in order). Setting a filter while flat-list mode is active SHALL be a no-op for rendering but SHALL store the filter for when flat-list mode is exited.

### Requirement: matchData passed through in flat-list mode

The system SHALL accept an optional second argument `matchDataMap: ReadonlyMap<T, IMatchData>` to `setFlatItems(items, matchDataMap?)`. When provided, the renderer SHALL receive the matching `IMatchData` for each rendered row via the same `renderElement` parameter as the filter case.

