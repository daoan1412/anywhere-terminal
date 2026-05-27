// src/pty/ShellIntegrationEvents.ts — Typed events emitted by the OSC parser.
//
// The parser converts raw OSC 7 + OSC 633 sequences in the PTY data stream into
// these structured events. Consumers (TerminalSession.commands) react to them
// to build a tracked-command list. See:
//   asimov/changes/export-terminal-session/specs/shell-integration-tracker/spec.md
//   asimov/changes/export-terminal-session/design.md D2

/** A single typed event produced by the OSC parser.
 *
 * The `text` variant carries a non-OSC plain-text segment from the PTY data
 * stream. Consumers route it into the tracked-command's output buffer ONLY
 * while a command is in flight — see [B1] in
 * `asimov/changes/export-terminal-session/.reviews/round-2.md`. Routing here
 * instead of the raw `onData` chunk eliminates the prior ordering bug where a
 * `[output][D]`-shaped single chunk closed the in-flight before `appendOutput`
 * saw it, dropping the output entirely.
 */
export type ShellIntegrationEvent =
  | { readonly kind: "cwd"; readonly cwd: string }
  | { readonly kind: "promptStart" }
  | { readonly kind: "commandStart" }
  | { readonly kind: "commandEnd"; readonly exitCode: number | null }
  | { readonly kind: "commandLine"; readonly commandLine: string; readonly nonceValid: boolean }
  | { readonly kind: "text"; readonly text: string };

/** Callback shape consumed by `OscParser.feed`. */
export type ShellIntegrationSink = (event: ShellIntegrationEvent) => void;
