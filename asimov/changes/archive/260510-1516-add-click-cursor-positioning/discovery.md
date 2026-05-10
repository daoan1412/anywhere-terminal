# Discovery: add-click-cursor-positioning

## Workstreams

| Workstream | Status | Method |
|---|---|---|
| Memory Recall | Done | `bun run asm memory search` returned no index |
| Architecture Snapshot | Done | finder subagent |
| Internal Patterns | Done | finder subagent |
| External Research | Done | librarian subagent; persisted to `docs/research/20260508-xterm-click-cursor-positioning.md` |
| Constraint Check | Done | direct read of `asimov/project.md`, design docs, and `package.json` |

## Key Findings

### 1. Input path is already suitable

Terminal input already flows from xterm.js through `terminal.onData` into `vscode.postMessage({ type: 'input', tabId, data })`, then the extension writes that data to the matching PTY session. Existing keyboard shortcuts and drag/drop path insertion both reuse this raw input path, so cursor movement should avoid adding a new IPC message type unless a webview-side approach proves impossible.

Relevant references:

- `src/webview/terminal/TerminalFactory.ts#L103-L125` wires `terminal.onData` to `input` messages.
- `src/types/messages.ts#L83-L90` defines the current `InputMessage` contract.
- `docs/design/flow-user-input.md` documents arrow-key escape sequences and raw input round trip.

### 2. Click focus already exists for split panes

Split pane containers already listen for `mousedown` and focus the clicked terminal instance. Any click-to-cursor implementation must preserve that behavior and must route movement to the clicked pane/session, not just the active tab.

Relevant references:

- `src/webview/split/SplitTreeRenderer.ts#L104-L123` sets the active pane and calls `terminal.focus()` on click.
- `src/webview/terminal/TerminalFactory.ts#L300-L319` focuses active panes after fitting.

### 3. xterm.js has Alt+Click cursor movement, not plain click

xterm.js exposes `altClickMovesCursor`, which is enabled by default and moves the cursor only when Alt is held. The requested behavior is plain click. External research found that xterm's built-in implementation maps click coordinates to terminal cells and emits relative cursor movement sequences, rather than using absolute CUP positioning.

Relevant references:

- `docs/research/20260508-xterm-click-cursor-positioning.md`
- `docs/design/xterm-integration.md` documents xterm constructor options and existing `macOptionClickForcesSelection: true` behavior.

### 4. Relative movement is safer than absolute CUP

Readline-style shells already understand arrow-key escape sequences such as `\x1b[D` and `\x1b[C`. xterm's own move-to-cell helper uses relative movement (`A/B/C/D`) because it works better with the active cursor state and alternate buffer than absolute cursor positioning (`CUP`, `\x1b[row;colH`). Plain click should therefore generate relative movement from the current cursor position to the clicked cell.

### 5. Selection and scrollback need explicit guards

Plain click can conflict with mouse selection. To avoid breaking copy/select workflows, click-to-cursor should only run for an unmodified primary-button click, should skip when selection is active or the pointer is used for dragging, and should no-op while the user is scrolled back from the live prompt. xterm research recommends checking that the active buffer is not scrolled back before emitting movement input.

### 6. Mouse-aware CLIs and TUI apps require conservative gating

Follow-up research found that xterm exposes public state for `buffer.active.type` and `modes.mouseTrackingMode`. OpenCode has documented TUI mouse interaction, and Claude Code has changelog evidence for mouse selection/scroll and alternate-screen behavior. Click-to-cursor should therefore be treated as a plain-shell convenience and MUST skip when the active buffer is alternate or when `mouseTrackingMode` is not `none`.

Relevant references:

- `docs/research/20260508-xterm-click-cursor-conflicts.md`

## Gap Analysis

| Component | Have | Need | Gap |
|---|---|---|---|
| xterm initialization | Terminal options and input forwarding are centralized in `TerminalFactory` | Plain-click movement behavior attached per terminal instance | No handler exists for plain-click-to-cursor |
| Coordinate mapping | xterm exposes terminal dimensions and DOM bounds | Convert click pixel coordinates to 0-based terminal cell coordinates | Need a small utility or handler that clamps to terminal cols/rows |
| Cursor movement | Keyboard arrows already send relative ANSI sequences through input path | Generate relative cursor movement based on current cursor and clicked cell | Need movement sequence generation and tests |
| Split panes | Pane click focuses the correct terminal | Click movement must target the clicked pane's PTY | Must attach behavior to each terminal instance/container, not a global active tab only |
| Selection | xterm supports mouse selection and copy behavior | Preserve selection/drag workflows | Need guard logic for selection, modified clicks, and pointer movement |
| TUI/mouse-aware apps | xterm exposes active buffer type and mouse tracking mode | Preserve app-owned mouse handling | Need guards for alternate buffer and active mouse tracking modes |
| Settings | Existing config covers cursor blink/font/scrollback only | Decide whether behavior is always on or configurable | Product decision needed |

## Options

### Option A — Use existing xterm Alt+Click only

Document and preserve xterm's built-in `Alt+Click` movement. This is minimal but does not satisfy the user's requested plain-click behavior and keeps the inconvenient modifier requirement.

### Option B — Plain-click movement handler (Recommended)

Add a small webview-side click handler per terminal instance. It maps unmodified primary-button clicks to terminal cells, skips selection/scrollback cases, emits relative cursor movement escape sequences through the existing input path, and preserves split-pane focus behavior.

### Option C — Absolute CUP positioning

On click, send `\x1b[row;colH` using the clicked row/column. This is simpler to generate but is more likely to desynchronize shell/readline state and behaves poorly across alternate screen/fullscreen applications.

## Risks

1. **Selection regression** — Plain click may interfere with text selection if the handler fires on drag or modified click. Mitigation: only act on stable primary-button click with no existing selection and no modifier keys.
2. **Shell/application compatibility** — Cursor movement works best in readline-style shell prompts and should not promise support in vim, nano, htop, or mouse-aware CLIs. Mitigation: spec the behavior as terminal input movement, not arbitrary application cursor teleportation, and skip alternate buffer or active mouse tracking modes.
3. **Scrolled-back viewport** — Sending movement while the visible viewport is not at the live prompt could move relative to an unexpected cursor state. Mitigation: no-op when active buffer is scrolled back.
4. **xterm internals drift** — Coordinate conversion should use public dimensions where possible and avoid mutating private buffer state. Mitigation: use public `terminal.dimensions`/DOM bounds and existing input pipeline.

## Open Questions

1. Should plain click always move the cursor, or should it be configurable?
2. Should click-to-cursor be disabled when the terminal has an active text selection, even if the click would normally clear selection?
