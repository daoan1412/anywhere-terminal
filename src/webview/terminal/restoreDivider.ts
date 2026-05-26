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
  // Leading SGR Reset prevents residual styling from the serialized buffer
  // (e.g. bold/colored prompt) bleeding into the divider line.
  return `\x1b[0m\r\n\x1b[2m${body}\x1b[0m\r\n`;
}
