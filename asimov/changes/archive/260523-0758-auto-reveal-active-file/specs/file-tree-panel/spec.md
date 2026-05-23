## MODIFIED Requirements

### Requirement: State persistence schema

The system SHALL persist the file tree's `open: boolean`, its current `position: 'top' | 'bottom' | 'left' | 'right'`, and its `expandedPaths: string[]` into `WebviewStateStore` under a single new key `fileTree` on the `WebviewState` interface. The schema SHALL be additive so future fields (selection, scroll, sash size, custom names, last-revealed-path) can be added without migration.
