// src/commands/exportCommands.ts — Three command palette entries:
//
//   anywhereTerminal.exportBuffer         → full scrollback dump
//   anywhereTerminal.exportLastCommand    → most-recently-completed command
//   anywhereTerminal.exportCommand        → quickpick over tracked commands
//
// See:
//   asimov/changes/export-terminal-session/specs/terminal-session-export/spec.md
//   asimov/changes/export-terminal-session/design.md D6, D7, D8

import stripAnsi from "strip-ansi";
import * as vscode from "vscode";
import type { SessionManager } from "../session/SessionManager";
import type { TrackedCommand } from "../session/TrackedCommand";
import {
  applyAnsiPreference,
  defaultExportFilename,
  formatCommandBlock,
  preferenceFromExtension,
  writeExportAtomically,
} from "./exportHelpers";

/** Caller-supplied lookup: returns the focused session id or undefined. */
export type GetFocusedSessionId = () => string | undefined;

/** Caller-supplied lookup: resolves a sessionId to a display name. */
export type GetSessionName = (sessionId: string) => string;

/** Vscode surface used by the commands — narrow on purpose for tests. */
export interface VscodeSurface {
  showSaveDialog(opts: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined>;
  showQuickPick<T extends vscode.QuickPickItem>(
    items: readonly T[] | Thenable<readonly T[]>,
    options?: vscode.QuickPickOptions,
  ): Thenable<T | undefined>;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
  showWarningMessage(message: string): Thenable<string | undefined>;
  showErrorMessage(message: string): Thenable<string | undefined>;
  openExternal(target: vscode.Uri): Thenable<boolean>;
  fs: vscode.FileSystem;
}

export interface ExportCommandDeps {
  sessionManager: SessionManager;
  getFocusedSessionId: GetFocusedSessionId;
  getSessionName: GetSessionName;
  vsc: VscodeSurface;
  /** README anchor URL used by the no-tracked-commands toast's `Help` button. */
  readmeShellIntegrationUrl: string;
}

export const NO_FOCUS_TOAST = "AnyWhere Terminal: focus a terminal session before exporting.";
const NO_TRACKED_TOAST =
  "AnyWhere Terminal: no tracked commands yet. Commands track from window reload onward and require shell integration — see Help.";
const HELP_LABEL = "Help";

const SAVE_DIALOG_FILTERS = {
  "Text (ANSI stripped)": ["txt", "log"],
  "Raw (ANSI preserved)": ["log", "ansi"],
};

// ─── Public entry points ────────────────────────────────────────────

export function exportBuffer(deps: ExportCommandDeps): Promise<void> {
  return runExport(deps, async (sessionId) => {
    let dump: { data: string; lineCount: number; truncated: boolean };
    try {
      dump = await deps.sessionManager.requestScrollbackDump(sessionId);
    } catch (err) {
      await deps.vsc.showErrorMessage(
        `AnyWhere Terminal: scrollback dump failed — ${err instanceof Error ? err.message : String(err)}.`,
      );
      return { abort: true };
    }
    return { content: dump.data };
  });
}

export function exportLastCommand(deps: ExportCommandDeps): Promise<void> {
  return runExport(deps, async (sessionId) => {
    const last = deps.sessionManager.getLastCompletedCommand(sessionId);
    if (!last) {
      return { skip: "no-tracked" };
    }
    return { content: formatCommandBlock(last) };
  });
}

export function exportCommand(deps: ExportCommandDeps): Promise<void> {
  return runExport(deps, async (sessionId) => {
    const commands = deps.sessionManager.getTrackedCommands(sessionId);
    // Spec: do not open an empty picker — surface the same toast as exportLastCommand.
    if (commands.length === 0) {
      return { skip: "no-tracked" };
    }
    // Most-recent first.
    const items = [...commands].reverse().map((cmd) => toQuickPickItem(cmd));
    const picked = await deps.vsc.showQuickPick(items, {
      placeHolder: "Select a command to export",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return { abort: true };
    }
    return { content: formatCommandBlock(picked.cmd) };
  });
}

// ─── Shared export pipeline ─────────────────────────────────────────

/**
 * Outcome of a per-command payload producer.
 *
 *   `content` — write this UTF-8 string to the user-chosen path (ANSI
 *               preference applied by `runExport`).
 *   `skip`    — surface the no-tracked-commands toast and return without
 *               opening the save dialog (spec D6: same toast for shell-
 *               integration-absent and reload-reset cases).
 *   `abort`   — silent return; the producer already surfaced its own toast
 *               or the user cancelled an intermediate dialog.
 */
type ExportProduceResult = { content: string } | { skip: "no-tracked" } | { abort: true };

/**
 * Drive the shared 5-step export skeleton: focus-check → produce payload →
 * save-dialog → ANSI preference → atomic write. Each command supplies only
 * the data-source lambda (`produce`); everything else lives here.
 *
 * See: .reviews/round-1.md [S3] — the three exporters were duplicating the
 * same skeleton with only the payload step varying.
 */
async function runExport(
  deps: ExportCommandDeps,
  produce: (sessionId: string) => Promise<ExportProduceResult>,
): Promise<void> {
  const sessionId = deps.getFocusedSessionId();
  if (!sessionId) {
    await deps.vsc.showWarningMessage(NO_FOCUS_TOAST);
    return;
  }
  const produced = await produce(sessionId);
  if ("skip" in produced) {
    await surfaceNoTrackedToast(deps);
    return;
  }
  if ("abort" in produced) {
    return;
  }
  const target = await promptSaveTarget(deps, sessionId);
  if (!target) {
    return;
  }
  const { preserveAnsi } = preferenceFromExtension(target.fsPath);
  const content = applyAnsiPreference(produced.content, preserveAnsi);
  await writeWithErrorToast(deps, target, content);
}

// ─── Helpers ────────────────────────────────────────────────────────

interface CommandQuickPickItem extends vscode.QuickPickItem {
  cmd: TrackedCommand;
}

/** Preview lines pulled from `cmd.output` to render under each quickpick item. */
const PREVIEW_LINES = 2;
/** Cap per preview line so wide outputs don't overflow the quickpick row. */
const PREVIEW_LINE_CHARS = 100;

function toQuickPickItem(cmd: TrackedCommand): CommandQuickPickItem {
  const labelSource = cmd.commandLine || "(command line not recorded)";
  // Truncate at 80 chars per spec.
  const label = labelSource.length > 80 ? `${labelSource.slice(0, 79)}…` : labelSource;
  const exit = cmd.exitCode === null ? "?" : String(cmd.exitCode);
  const cwd = cmd.cwd ?? "?";
  // Metadata (exit/cwd/age) → description column (rendered next to label).
  // Output preview → detail (rendered wrapped below). This puts the most
  // information in the most useful place: scanning is via labels, choosing
  // a specific historical command leans on the preview lines.
  const description = `exit ${exit} · ${cwd} · ${formatRelativeTime(cmd.endedAt, Date.now())}`;
  const detail = formatOutputPreview(cmd.output);
  return { label, description, detail, cmd };
}

/**
 * Build a single-line, ANSI-stripped preview of the first non-blank output
 * lines of a tracked command. Returns "(no output)" when there's nothing
 * useful to show — the quickpick still renders the metadata description.
 */
export function formatOutputPreview(output: string): string {
  if (!output) {
    return "(no output)";
  }
  const stripped = stripAnsi(output);
  const lines: string[] = [];
  for (const raw of stripped.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    lines.push(line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS - 1)}…` : line);
    if (lines.length >= PREVIEW_LINES) {
      break;
    }
  }
  if (lines.length === 0) {
    return "(no output)";
  }
  return lines.join(" ⏎ ");
}

/**
 * Lightweight relative-time formatter — avoids pulling in `date-fns` for one
 * usage. Granularity: now, Ns, Nm, Nh, Nd. `now` is the reference time
 * (injectable for tests).
 */
export function formatRelativeTime(endedAt: number | null, now: number): string {
  if (endedAt === null) {
    return "in flight";
  }
  const diff = Math.max(0, now - endedAt);
  const s = Math.floor(diff / 1000);
  if (s < 5) {
    return "just now";
  }
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function promptSaveTarget(deps: ExportCommandDeps, sessionId: string): Promise<vscode.Uri | undefined> {
  const name = deps.getSessionName(sessionId);
  const defaultName = defaultExportFilename(name, "txt");
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = folder ? vscode.Uri.joinPath(folder, defaultName) : vscode.Uri.file(defaultName);
  return deps.vsc.showSaveDialog({
    defaultUri,
    filters: SAVE_DIALOG_FILTERS,
    saveLabel: "Export",
    title: "Export Terminal Session",
  });
}

async function surfaceNoTrackedToast(deps: ExportCommandDeps): Promise<void> {
  const choice = await deps.vsc.showInformationMessage(NO_TRACKED_TOAST, HELP_LABEL);
  if (choice === HELP_LABEL) {
    await deps.vsc.openExternal(vscode.Uri.parse(deps.readmeShellIntegrationUrl));
  }
}

async function writeWithErrorToast(deps: ExportCommandDeps, target: vscode.Uri, content: string): Promise<void> {
  try {
    await writeExportAtomically(target, content, deps.vsc.fs);
  } catch (err) {
    await deps.vsc.showErrorMessage(
      `AnyWhere Terminal: failed to write ${target.fsPath} — ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}
