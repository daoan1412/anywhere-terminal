// src/commands/exportCommands.test.ts
//
// Unit tests for the three export commands. Each command is exercised
// through a fully-stubbed VscodeSurface + a fake SessionManager. The
// underlying pure helpers (formatCommandBlock, writeExportAtomically) are
// covered separately in exportHelpers.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { TrackedCommand } from "../session/TrackedCommand";
import {
  exportBuffer,
  exportCommand,
  exportLastCommand,
  type ExportCommandDeps,
  formatOutputPreview,
  formatRelativeTime,
  type VscodeSurface,
} from "./exportCommands";

// ─── Fakes ──────────────────────────────────────────────────────────

interface FakeFs {
  writes: Array<{ path: string; payload: string }>;
  failOnce?: { reason: string };
}

function makeFakeFs(): FakeFs & vscode.FileSystem {
  const writes: Array<{ path: string; payload: string }> = [];
  let failNextRename = false;
  const fs: FakeFs & {
    writeFile(uri: vscode.Uri, bytes: Uint8Array): Promise<void>;
    rename(src: vscode.Uri, dst: vscode.Uri, opts: { overwrite: boolean }): Promise<void>;
    delete(uri: vscode.Uri): Promise<void>;
  } = {
    writes,
    failOnce: undefined,
    async writeFile(uri: vscode.Uri, bytes: Uint8Array) {
      if (fs.failOnce?.reason) {
        // Defer to rename so the .tmp file gets written first.
        failNextRename = true;
      }
      writes.push({ path: uri.fsPath, payload: Buffer.from(bytes).toString("utf8") });
    },
    async rename(_src: vscode.Uri, _dst: vscode.Uri, _opts: { overwrite: boolean }) {
      if (failNextRename) {
        const reason = fs.failOnce!.reason;
        fs.failOnce = undefined;
        failNextRename = false;
        throw new Error(reason);
      }
    },
    async delete(_uri: vscode.Uri) {},
  };
  return fs as unknown as FakeFs & vscode.FileSystem;
}

interface RecordedToast {
  kind: "info" | "warn" | "error";
  message: string;
  items: string[];
}

function makeSurface(opts?: {
  saveTarget?: vscode.Uri | undefined;
  pickIndex?: number; // index into items array
  helpResponse?: boolean;
}) {
  const toasts: RecordedToast[] = [];
  const openExternalCalls: string[] = [];
  const fs = makeFakeFs();
  const surface: VscodeSurface = {
    showSaveDialog: vi.fn(async () => opts?.saveTarget),
    showQuickPick: vi.fn(async (items) => {
      const arr = await Promise.resolve(items);
      const idx = opts?.pickIndex ?? -1;
      return idx >= 0 && idx < arr.length ? arr[idx] : undefined;
    }),
    showInformationMessage: vi.fn(async (msg, ...items) => {
      toasts.push({ kind: "info", message: msg, items });
      return opts?.helpResponse ? "Help" : undefined;
    }),
    showWarningMessage: vi.fn(async (msg) => {
      toasts.push({ kind: "warn", message: msg, items: [] });
      return undefined;
    }),
    showErrorMessage: vi.fn(async (msg) => {
      toasts.push({ kind: "error", message: msg, items: [] });
      return undefined;
    }),
    openExternal: vi.fn(async (uri) => {
      // The vscode mock's Uri shape varies — try common shapes.
      const u = uri as { toString?: () => string; fsPath?: string; path?: string };
      openExternalCalls.push(u.fsPath ?? u.path ?? u.toString?.() ?? "");
      return true;
    }),
    fs,
  };
  return { surface, toasts, openExternalCalls, fs };
}

interface FakeSessionManagerState {
  scrollbackDump?: { data: string; lineCount: number; truncated: boolean } | Error;
  trackedCommands?: TrackedCommand[];
  lastCompleted?: TrackedCommand | null;
}

function makeSessionManager(state: FakeSessionManagerState = {}) {
  return {
    async requestScrollbackDump() {
      if (state.scrollbackDump instanceof Error) throw state.scrollbackDump;
      return state.scrollbackDump ?? { data: "", lineCount: 0, truncated: false };
    },
    getTrackedCommands() {
      return state.trackedCommands ?? [];
    },
    getLastCompletedCommand() {
      return state.lastCompleted ?? null;
    },
  } as unknown as ExportCommandDeps["sessionManager"];
}

function makeDeps(opts: {
  surface: VscodeSurface;
  sessionManager: ExportCommandDeps["sessionManager"];
  focusedSessionId?: string;
}): ExportCommandDeps {
  return {
    sessionManager: opts.sessionManager,
    getFocusedSessionId: () => opts.focusedSessionId,
    getSessionName: (id) => `Terminal-${id}`,
    vsc: opts.surface,
    readmeShellIntegrationUrl: "https://example.com/readme#shell-integration",
  };
}

function makeTrackedCommand(o: Partial<TrackedCommand> = {}): TrackedCommand {
  return {
    id: "cmd-1",
    commandLine: "pnpm test",
    output: "all green\n",
    exitCode: 0,
    cwd: "/srv/app",
    startedAt: 1000,
    endedAt: 2000,
    outputBytes: 10,
    outputTruncated: false,
    ...o,
  };
}

// ─── exportBuffer ───────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 4, 26, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("exportBuffer", () => {
  it("warns when no focused session", async () => {
    const { surface, toasts } = makeSurface();
    const deps = makeDeps({ surface, sessionManager: makeSessionManager(), focusedSessionId: undefined });
    await exportBuffer(deps);
    expect(toasts).toEqual([
      { kind: "warn", message: "AnyWhere Terminal: focus a terminal session before exporting.", items: [] },
    ]);
    expect(surface.showSaveDialog).not.toHaveBeenCalled();
  });

  it("posts an error toast when the dump fails", async () => {
    const { surface, toasts } = makeSurface();
    const sm = makeSessionManager({ scrollbackDump: new Error("timed out") });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportBuffer(deps);
    expect(toasts).toEqual([
      {
        kind: "error",
        message: "AnyWhere Terminal: scrollback dump failed — timed out.",
        items: [],
      },
    ]);
    expect(surface.showSaveDialog).not.toHaveBeenCalled();
  });

  it("ANSI-strips by default and writes to the chosen path", async () => {
    const target = vscode.Uri.file("/tmp/out.txt");
    const { surface, fs } = makeSurface({ saveTarget: target });
    const sm = makeSessionManager({ scrollbackDump: { data: "\x1b[31mhello\x1b[0m", lineCount: 1, truncated: false } });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportBuffer(deps);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].path).toBe("/tmp/out.txt.tmp");
    expect(fs.writes[0].payload).toBe("hello");
  });

  it("preserves ANSI when filename ends in .ansi", async () => {
    const target = vscode.Uri.file("/tmp/out.ansi");
    const { surface, fs } = makeSurface({ saveTarget: target });
    const sm = makeSessionManager({ scrollbackDump: { data: "\x1b[31mhello\x1b[0m", lineCount: 1, truncated: false } });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportBuffer(deps);
    expect(fs.writes[0].payload).toBe("\x1b[31mhello\x1b[0m");
  });

  it("is a no-op when the user cancels the save dialog", async () => {
    const { surface, fs } = makeSurface({ saveTarget: undefined });
    const sm = makeSessionManager({ scrollbackDump: { data: "x", lineCount: 1, truncated: false } });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportBuffer(deps);
    expect(fs.writes).toEqual([]);
  });
});

// ─── exportLastCommand ──────────────────────────────────────────────

describe("exportLastCommand", () => {
  it("surfaces the no-tracked-commands info toast with Help button when null", async () => {
    const { surface, toasts } = makeSurface();
    const sm = makeSessionManager({ lastCompleted: null });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportLastCommand(deps);
    expect(toasts).toEqual([
      {
        kind: "info",
        message:
          "AnyWhere Terminal: no tracked commands yet. Commands track from window reload onward and require shell integration — see Help.",
        items: ["Help"],
      },
    ]);
    expect(surface.showSaveDialog).not.toHaveBeenCalled();
  });

  it("opens the README anchor when Help is clicked", async () => {
    const { surface, openExternalCalls } = makeSurface({ helpResponse: true });
    const sm = makeSessionManager({ lastCompleted: null });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportLastCommand(deps);
    // openExternal should be invoked exactly once with something derived from
    // the configured URL. The vscode mock's `Uri.parse` strips the fragment;
    // we only assert on the stable substring "readme".
    expect(openExternalCalls).toHaveLength(1);
    expect(openExternalCalls[0]).toContain("readme");
    expect(surface.openExternal).toHaveBeenCalledTimes(1);
  });

  it("writes the formatted block when a command exists", async () => {
    const target = vscode.Uri.file("/tmp/cmd.txt");
    const { surface, fs } = makeSurface({ saveTarget: target });
    const last = makeTrackedCommand({ commandLine: "echo hi", output: "hi\n" });
    const sm = makeSessionManager({ lastCompleted: last });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportLastCommand(deps);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].payload).toBe("$ echo hi\n[exit 0] [cwd /srv/app]\n\nhi\n");
  });
});

// ─── exportCommand (picker) ─────────────────────────────────────────

describe("exportCommand picker", () => {
  it("falls back to the no-tracked-commands toast when the list is empty", async () => {
    const { surface, toasts } = makeSurface();
    const sm = makeSessionManager({ trackedCommands: [] });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportCommand(deps);
    expect(surface.showQuickPick).not.toHaveBeenCalled();
    expect(toasts[0].message).toContain("no tracked commands yet");
  });

  it("shows the picker with most-recent-first ordering and writes the selection", async () => {
    const target = vscode.Uri.file("/tmp/cmd.txt");
    const a = makeTrackedCommand({ id: "a", commandLine: "first", endedAt: 1000, output: "A\n" });
    const b = makeTrackedCommand({ id: "b", commandLine: "second", endedAt: 2000, output: "B\n" });
    const c = makeTrackedCommand({ id: "c", commandLine: "third", endedAt: 3000, output: "C\n" });
    // pickIndex 0 = newest after reverse (c)
    const { surface, fs } = makeSurface({ saveTarget: target, pickIndex: 0 });
    const sm = makeSessionManager({ trackedCommands: [a, b, c] });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportCommand(deps);
    const itemsArg = (surface.showQuickPick as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    const items = (await Promise.resolve(itemsArg)) as Array<{ label: string }>;
    expect(items.map((i) => i.label)).toEqual(["third", "second", "first"]);
    expect(fs.writes[0].payload).toContain("$ third");
    expect(fs.writes[0].payload).toContain("C\n");
  });

  it("truncates labels longer than 80 chars with an ellipsis", async () => {
    const longCmd = "x".repeat(120);
    const cmd = makeTrackedCommand({ commandLine: longCmd });
    const { surface } = makeSurface({ saveTarget: undefined });
    const sm = makeSessionManager({ trackedCommands: [cmd] });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportCommand(deps);
    const itemsArg = (surface.showQuickPick as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    const items = (await Promise.resolve(itemsArg)) as Array<{ label: string }>;
    expect(items[0].label).toBe(`${"x".repeat(79)}…`);
    expect(items[0].label.length).toBe(80);
  });

  it("is a no-op when the user dismisses the picker", async () => {
    const { surface, fs } = makeSurface({ pickIndex: -1 });
    const sm = makeSessionManager({ trackedCommands: [makeTrackedCommand()] });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportCommand(deps);
    expect(fs.writes).toEqual([]);
  });
});

// ─── Write-failure error toast (shared path) ────────────────────────

describe("write-failure error toast (shared path)", () => {
  it("surfaces an error toast with the failing path + reason", async () => {
    const target = vscode.Uri.file("/tmp/readonly/out.txt");
    const { surface, fs, toasts } = makeSurface({ saveTarget: target });
    fs.failOnce = { reason: "EACCES: permission denied" };
    const sm = makeSessionManager({ scrollbackDump: { data: "x", lineCount: 1, truncated: false } });
    const deps = makeDeps({ surface, sessionManager: sm, focusedSessionId: "s1" });
    await exportBuffer(deps);
    expect(toasts.some((t) => t.kind === "error" && t.message.includes("/tmp/readonly/out.txt"))).toBe(true);
    expect(toasts.some((t) => t.kind === "error" && t.message.includes("EACCES: permission denied"))).toBe(true);
  });
});

// ─── Relative-time formatter ────────────────────────────────────────

describe("formatRelativeTime", () => {
  const now = new Date(2026, 4, 26, 10, 0, 0).getTime();
  it("returns 'just now' for diffs < 5 s", () => {
    expect(formatRelativeTime(now - 3_000, now)).toBe("just now");
  });
  it("returns Ns for 5 ≤ diff < 60 s", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("30s ago");
  });
  it("returns Nm for 1–60 min", () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  });
  it("returns Nh for 1–48 h", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
  it("returns Nd for ≥ 48 h", () => {
    expect(formatRelativeTime(now - 3 * 24 * 3_600_000, now)).toBe("3d ago");
  });
  it("returns 'in flight' for null endedAt", () => {
    expect(formatRelativeTime(null, now)).toBe("in flight");
  });
  it("clamps negative diffs to 'just now'", () => {
    expect(formatRelativeTime(now + 5000, now)).toBe("just now");
  });
});

describe("formatOutputPreview", () => {
  it("returns '(no output)' for empty input", () => {
    expect(formatOutputPreview("")).toBe("(no output)");
  });
  it("returns '(no output)' when only blank lines remain after trim", () => {
    expect(formatOutputPreview("   \n\n   \n")).toBe("(no output)");
  });
  it("strips ANSI sequences before previewing", () => {
    expect(formatOutputPreview("\x1b[31mhello\x1b[0m world")).toBe("hello world");
  });
  it("joins first two non-blank lines with ' ⏎ '", () => {
    expect(formatOutputPreview("foo\n\nbar\nbaz")).toBe("foo ⏎ bar");
  });
  it("truncates each line at PREVIEW_LINE_CHARS", () => {
    const long = "x".repeat(200);
    const out = formatOutputPreview(long);
    // 99 chars + ellipsis = 100 chars
    expect(out).toMatch(/^x{99}…$/);
  });
});
