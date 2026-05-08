# Design: support-cursor-integration

## Decisions

### D1: Lower the supported VS Code API floor to 1.105

Set `package.json` `engines.vscode` to `^1.105.0`. Cursor 3.2.21 identifies as VS Code 1.105.1, and the API audit found no use of APIs introduced after 1.105.

Rejected alternatives:
- Keep `^1.107.0`: preserves current metadata but continues blocking the reported Cursor install path.
- Pin exactly to `>=1.105.0 <1.106.0`: supports the reported Cursor version but unnecessarily blocks newer VS Code and Cursor releases.

### D2: Align type definitions with the manifest floor

Set `@types/vscode` to exact `1.105.0` and refresh the lockfile. This keeps compile-time API availability aligned with the oldest supported host; using `^1.105.0` still resolves to newer 1.x type packages under pnpm.

Rejected alternatives:
- Leave `@types/vscode` at `^1.107.0`, which could allow future code to compile against APIs not available in Cursor 3.2.21.
- Use `^1.105.0`, which satisfies the manifest floor on paper but still resolves to newer 1.x API types.

### D3: Keep runtime architecture host-neutral

Do not add Cursor-specific runtime branches for activation, views, webviews, or PTY loading in this change. The reported failure happens before activation, and the existing architecture uses standard VS Code extension host APIs available in 1.105.

Rejected alternative: add Cursor detection or custom node-pty lookup immediately. That increases maintenance burden without evidence of a runtime failure after the install blocker is removed.

### D4: Verify Cursor with a manual smoke checklist

Document a manual Cursor smoke check for installing the packaged VSIX, opening the sidebar/panel/editor terminal surfaces, and confirming shell output. Standard VS Code tests remain the automated baseline.

Rejected alternative: add automated Cursor CI now. Discovery found no official Cursor extension test harness, so manual smoke verification is the reliable near-term path.

## Risk Map

| Component | Risk | Mitigation |
|---|---|---|
| Manifest compatibility | Lowering the engine floor could expose unsupported API usage on 1.105 hosts | D1 and D2 require the engine floor and type definitions to align at 1.105; run `pnpm run check-types` and `pnpm run test:unit` |
| Cursor runtime | Install succeeds but PTY loading fails because Cursor's app root differs from VS Code | D3 keeps runtime unchanged for this install fix; D4 smoke checklist requires terminal creation and output verification so runtime failures become explicit follow-up work |
| Distribution | Cursor users still cannot find the extension if only VS Marketplace is published | Task documentation must state Open VSX as the Cursor-primary install path and VSIX as fallback |
| Release QA | No official Cursor CI harness exists | D4 requires repeatable manual smoke steps instead of ad hoc testing |
