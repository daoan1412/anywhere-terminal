## ADDED Requirements

### Requirement: Cursor-compatible engine floor

The system SHALL declare a VS Code engine floor no higher than `^1.105.0` while it only uses extension APIs available in VS Code 1.105.

#### Scenario: Cursor 3.2.21 install

- **WHEN** a user installs the extension into Cursor 3.2.21 with VS Code version 1.105.1
- **THEN** the manifest compatibility check MUST NOT reject the extension because of `engines.vscode`.

### Requirement: API type floor alignment

The system SHALL pin `@types/vscode` to `1.105.0` so type-checking does not silently allow APIs newer than the supported host baseline.

### Requirement: Cursor install guidance

The system SHALL document Cursor installation through Open VSX and VSIX fallback without relying on Cursor's unsupported Marketplace backend switching.

### Requirement: Cursor smoke verification

The system SHALL provide a repeatable manual smoke check that verifies install, activation, terminal creation, and basic PTY output in Cursor.
