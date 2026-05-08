# Proposal: support-cursor-integration

## Why

Cursor 3.2.21 reports VS Code 1.105.1 and rejects AnyWhere Terminal because the extension declares `engines.vscode` as `^1.107.0`. The code uses API surfaces available by VS Code 1.105, so the compatibility floor should match the actual API requirement.

## Appetite

S (≤1d)

## Scope

### In scope
- Lower the manifest VS Code engine floor to support Cursor 3.2.21 / VS Code 1.105.1.
- Align VS Code type definitions with the supported API floor.
- Add Cursor install and smoke verification documentation for Open VSX and VSIX fallback.
- Run type-check and unit verification after the compatibility change.

### Out of scope
- Bundling or vendoring `node-pty` native binaries.
- Adding Cursor-specific runtime code paths without a reproduced runtime failure.
- Automating Cursor CI smoke tests, because no official Cursor extension test harness was found.
- Changing the extension UI, commands, or terminal behavior.

## Capabilities

1. **cursor-host-compatibility** — The extension can install on Cursor hosts whose VS Code baseline is 1.105.x while keeping standard VS Code compatibility.

## UI Impact & E2E

- **User-visible UI behavior affected?** NO
- **E2E required?** NOT REQUIRED
- **Justification**: The change affects install compatibility and documentation, not in-extension UI behavior. A manual Cursor smoke check is required because the blocker occurs in Cursor's extension installer rather than in the VS Code test host.

## Risk Level

LOW — API audit found no API usage requiring VS Code newer than 1.105, and the runtime architecture remains unchanged.
