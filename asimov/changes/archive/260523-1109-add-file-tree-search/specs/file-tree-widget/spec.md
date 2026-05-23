## ADDED Requirements

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
