## ADDED Requirements

### Requirement: Plain click moves prompt cursor

The system SHALL move the terminal prompt cursor toward the clicked terminal cell when the user performs an unmodified primary-button click in the live terminal viewport.

#### Scenario: Click inside editable prompt

- **WHEN** the terminal viewport is at the live prompt and the user primary-clicks a visible cell without modifier keys
- **THEN** the terminal SHALL send relative cursor movement input for the clicked terminal instance through the existing input path.

### Requirement: Selection and modified clicks remain unchanged

The system SHALL NOT send click-to-cursor movement input for modified clicks, non-primary-button clicks, drag/selection gestures, or clicks while terminal text is selected.

### Requirement: Scrolled-back clicks are ignored

The system SHALL NOT send click-to-cursor movement input when the visible terminal viewport is scrolled back from the live buffer position.

### Requirement: App mouse modes are preserved

The system SHALL NOT send click-to-cursor movement input when xterm reports an alternate active buffer or a mouse tracking mode other than `none`.

#### Scenario: Mouse-aware CLI owns clicks

- **WHEN** a terminal application has enabled mouse tracking or switched xterm to the alternate buffer
- **THEN** the click-to-cursor handler SHALL leave click handling to xterm and the terminal application.

### Requirement: Split pane target is preserved

The system SHALL apply click-to-cursor movement to the terminal instance that received the click, without changing input routing to a different tab or split pane.
