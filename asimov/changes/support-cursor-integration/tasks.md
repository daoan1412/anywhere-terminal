## 1. Cursor Install Compatibility

- [x] 1_1 Lower VS Code compatibility floor
  - **Deps**: none
  - **Refs**: specs/cursor-host-compatibility/spec.md#requirement-cursor-compatible-engine-floor; specs/cursor-host-compatibility/spec.md#requirement-api-type-floor-alignment; design.md D1; design.md D2; docs/research/20260508-cursor-extension-integration.md
  - **Scope**: package.json, pnpm-lock.yaml
  - **Acceptance**:
    - Outcome: Cursor 3.2.21 / VS Code 1.105.1 is no longer rejected by the extension manifest version floor.
    - Verify: manual package.json declares `engines.vscode` as `^1.105.0`, `@types/vscode` as `1.105.0`, and the lockfile resolves `@types/vscode@1.105.0`
  - **Plan**:
    1. Update `package.json` `engines.vscode` from `^1.107.0` to `^1.105.0` and `@types/vscode` from `^1.107.0` to exact `1.105.0`.
    2. Run the package manager install command only if the lockfile requires regeneration.
    3. Do not change activation events, command IDs, view IDs, or runtime code in this task.

- [x] 1_2 Document Cursor install path and smoke check
  - **Deps**: 1_1
  - **Refs**: specs/cursor-host-compatibility/spec.md#requirement-cursor-install-guidance; specs/cursor-host-compatibility/spec.md#requirement-cursor-smoke-verification; design.md D3; design.md D4; docs/research/20260508-cursor-extension-integration.md
  - **Scope**: README.md, docs/research/20260508-cursor-extension-integration.md
  - **Acceptance**:
    - Outcome: Users and maintainers have a clear Cursor install path through Open VSX or VSIX fallback and a repeatable Cursor smoke check.
    - Verify: manual README includes Cursor install and smoke verification guidance
  - **Plan**:
    1. Add a README compatibility note naming Cursor 3.2.21 / VS Code 1.105.1 support.
    2. Document Open VSX as the primary Cursor discovery channel and VSIX sideload as fallback.
    3. Add concise smoke steps covering install, activation, terminal creation, and basic command output.
    4. Keep the research doc as supporting context only; update it if implementation reveals a changed install path.

- [ ] 1_3 Verify compatibility baseline
  - **Deps**: 1_1, 1_2
  - **Refs**: specs/cursor-host-compatibility/spec.md#requirement-cursor-compatible-engine-floor; specs/cursor-host-compatibility/spec.md#requirement-cursor-smoke-verification; design.md D1; design.md D4
  - **Scope**: package.json, README.md
  - **Acceptance**:
    - Outcome: The compatibility change passes automated project checks and has a documented Cursor install smoke result.
    - Verify: manual `pnpm run check-types`, `pnpm run test:unit`, and Cursor VSIX install smoke check pass
  - **Plan**:
    1. Run `pnpm run check-types`.
    2. Run `pnpm run test:unit`.
    3. Build a VSIX with the existing script and install it in Cursor 3.2.21.
    4. Record any runtime failure as a follow-up; do not add runtime work unless the smoke test reproduces it.
