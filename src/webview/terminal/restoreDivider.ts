// Restore-divider formatter — pure function so the webview router can keep its
// case body short and the divider format stays unit-testable.
// See: asimov/changes/restore-terminal-sessions/design.md D9.

export interface FormatRestoreDividerInput {
  snapshotAt: number;
  shellExited: boolean;
  exitCode: number | null;
}

export function formatRestoreDivider({ snapshotAt, shellExited, exitCode }: FormatRestoreDividerInput): string {
  const date = new Date(snapshotAt);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const base = `─── restored — last update at ${hh}:${mm}`;
  const body = shellExited ? `${base} (shell exited, code: ${exitCode ?? "?"}) ───` : `${base} ───`;
  // Layout: `\r\x1b[2K` overlays the cursor's current row (= the previous
  // shell's inherited prompt line, drawn by the serialized buffer just before
  // this divider) instead of moving down to a fresh line. Result: divider
  // visually replaces the most-recent stale prompt instead of stacking under
  // it. SGR reset prevents residual prompt styling from bleeding into the
  // divider; trailing `\r\n` moves cursor down for the live shell's prompt.
  return `\r\x1b[2K\x1b[0m\x1b[2m${body}\x1b[0m\r\n`;
}
