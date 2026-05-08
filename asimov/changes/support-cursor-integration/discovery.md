# Discovery: support-cursor-integration

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `bun run asm memory search` |
| Existing Design Docs | Done | direct read of `docs/DESIGN.md`, `docs/design/build-system.md`, `docs/design/pty-manager.md` |
| Architecture Snapshot | Done | finder subagent |
| Internal Patterns | Done | finder subagent |
| External Research | Done | librarian subagent, persisted to `docs/research/20260508-cursor-extension-integration.md` |
| Constraint Check | Done | direct read of `package.json` and `.vscodeignore` |

## Key Findings

### 1. Cursor should be treated as a VS Code-compatible desktop host, not a separate runtime

Cursor is a VS Code-compatible desktop application that consumes VS Code-style extension manifests. The existing extension architecture already aligns with this model: activation is through VS Code contribution points, backend code runs in the Extension Host, UI is rendered in webviews, and commands/views are declared in `package.json`.

The concrete reported blocker is install compatibility: Cursor 3.2.21 reports VS Code 1.105.1 and rejects the extension because `package.json` declares `engines.vscode` as `^1.107.0`. A targeted API floor audit found no API usage that requires VS Code newer than 1.105, so the plan should lower the declared floor instead of adding Cursor-specific runtime logic.

### 2. Distribution is the main product gap

Cursor's default extension source is Open VSX. Publishing only to VS Marketplace can leave Cursor users unable to discover or install the extension from the in-app extension browser. The existing scripts already include `deploy:ovsx`, `deploy:vsce`, combined `deploy`, and `vsix` packaging scripts, so the repo has the release primitives needed for Cursor support.

The recommended user-facing path is Open VSX as the primary Cursor distribution channel, with GitHub release VSIX as a fallback. VS Marketplace remains relevant for VS Code users but should not be the Cursor compatibility mechanism.

### 3. PTY loading is the main technical risk

The current design deliberately loads `node-pty` from `vscode.env.appRoot` instead of bundling native binaries. Existing memory and design docs call this out as intentional: avoiding native packaging keeps the VSIX small and portable, but assumes the host application provides a compatible internal `node-pty` layout.

Finder discovery identified `src/pty/PtyManager.ts#L62-L107` as the likely Cursor risk area because node-pty app-root paths are hard-coded to VS Code-style locations. If Cursor's app root layout differs, terminal creation can fail even when the extension installs successfully.

### 4. Manifest and view registrations are already standard VS Code contributions

The manifest declares `engines.vscode`, activation events, views, commands, menus, and keybindings in standard VS Code extension format. Relevant surfaces include `package.json#L25-L27`, `package.json#L31-L42`, `package.json#L44-L121`, and `package.json#L122-L390`.

The runtime providers reuse the same pattern for sidebar/panel/editor surfaces. Finder discovery identified `src/extension.ts#L10-L181`, `src/providers/TerminalViewProvider.ts#L17-L103`, and `src/providers/TerminalEditorProvider.ts#L53-L76` as the core registration paths.

The compatibility audit confirmed `WebviewViewProvider`, `WebviewPanel`, `viewsContainers.activitybar`, `viewsContainers.panel`, `webview/context`, `focusedView`, `env.appRoot`, `retainContextWhenHidden`, and `workbench.action.moveView` are available by VS Code 1.105. The recommended minimum manifest floor is `^1.105.0`.

### 5. Test coverage should add observability around host compatibility instead of requiring a Cursor-only harness

External research did not find an official Cursor CI test harness for extensions. Standard VS Code extension-host tests should remain the automated baseline, with a manual or scripted Cursor smoke test that installs a built VSIX into Cursor and validates the terminal surfaces.

The internal test patterns most relevant to this plan are activation/bootstrap checks, provider and command registration assertions, and PTY load failure messaging. Finder highlighted `src/test/extension.test.ts#L1-L16` and `src/test/__mocks__/vscode.ts#L127-L149` as likely starting points.

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| Distribution | `vsix`, `deploy:vsce`, `deploy:ovsx`, and combined `deploy` scripts exist | Clear Cursor-first release path and user install instructions | Cursor users may not know to use Open VSX or VSIX fallback |
| Manifest metadata | Standard VS Code extension manifest with `engines.vscode: ^1.107.0` | Declare `^1.105.0` to support Cursor 3.2.21 / VS Code 1.105.1 | Current floor blocks install even though used APIs are compatible |
| PTY loading | Dynamic load from VS Code app root | Host-compatible node-pty resolution or actionable error for Cursor | Cursor app root layout may not match current lookup paths |
| Runtime behavior | Standard webview/provider architecture | Verify activation, commands, views, and PTY creation in Cursor | VS Code tests alone do not prove Cursor runtime compatibility |
| Documentation | VS Code-oriented README and design docs | Cursor-specific install/troubleshooting section | Users may assume Marketplace install is enough |
| Release QA | VS Code test tooling and VSIX packaging | Cursor smoke checklist for Open VSX and VSIX install | No automated Cursor test harness is available |

## Options

### Option A — Documentation-only Cursor install guidance

Document how to install from Open VSX or VSIX and leave runtime code unchanged. This is the smallest change, but it does not address the highest technical risk: `node-pty` loading may fail in Cursor if the app-root layout differs from VS Code.

### Option B — Lower manifest floor and add Cursor verification (Recommended)

Treat Cursor as a VS Code-compatible desktop host, lower `engines.vscode` and `@types/vscode` to `^1.105.0`, document Cursor install paths, and add a Cursor smoke checklist. This directly fixes the reported install blocker without forking the runtime or adding native binaries.

### Option C — Ship bundled or platform-specific `node-pty` for Cursor

Bundle native PTY binaries or publish platform-specific VSIX packages to avoid relying on host internals. This may be more robust long-term, but it expands release complexity, native rebuild burden, package size, and CI matrix; it should be deferred unless Cursor cannot reliably provide compatible `node-pty` internals.

## Risks

1. **Cursor app-root layout mismatch** — Terminal creation may fail after install; mitigate by testing current lookup paths in Cursor and adding host-aware diagnostics or fallback lookup only where proven necessary.
2. **Engine floor mismatch** — Cursor may lag the declared VS Code API floor; mitigate by verifying the minimum Cursor build targeted by the smoke test and avoiding unnecessary API floor bumps.
3. **Marketplace assumption** — Users may look for the extension in Cursor and not find it if Open VSX is not published; mitigate by making Open VSX the Cursor-primary distribution path.
4. **Native module strategy creep** — Bundling `node-pty` would turn this into a native packaging project; mitigate by deferring bundled binaries until host-provided PTY loading is proven insufficient.
5. **Manual QA gap** — No official Cursor extension test runner was found; mitigate with a repeatable smoke checklist and standard VS Code automated tests for shared behavior.
