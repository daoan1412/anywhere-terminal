// src/providers/openFileLink.test.ts — Unit tests for openFileLink.

import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { OpenFileMessage } from "../types/messages";
import { type OpenFileLinkDeps, openFileLink } from "./openFileLink";

/** Build a stat function from a set of paths that "exist" (as files). */
function makeStat(existingFiles: Set<string>, existingDirs: Set<string> = new Set()) {
  return vi.fn(async (uri: vscode.Uri): Promise<vscode.FileStat> => {
    const fsPath = uri.fsPath;
    if (existingFiles.has(fsPath)) {
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 10 };
    }
    if (existingDirs.has(fsPath)) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    // Mimic vscode.FileSystemError.FileNotFound — opener silently swallows this.
    const err = new Error(`FileNotFound: ${fsPath}`) as Error & { code: string };
    err.code = "FileNotFound";
    throw err;
  });
}

function makeDeps(overrides: Partial<OpenFileLinkDeps> = {}): OpenFileLinkDeps {
  return {
    getInitialCwd: vi.fn(() => undefined),
    workspaceFolders: undefined,
    stat: makeStat(new Set()),
    showWarning: vi.fn(),
    showError: vi.fn(),
    showTextDocument: vi.fn(),
    ...overrides,
  } as OpenFileLinkDeps;
}

const msg = (overrides: Partial<OpenFileMessage> = {}): OpenFileMessage => ({
  type: "openFile",
  path: "src/foo.ts",
  sessionId: "sess-1",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openFileLink: resolution chain", () => {
  it("opens an absolute path that exists, no warning", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set(["/abs/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
    });
    await openFileLink(msg({ path: "/abs/foo.ts" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("resolves a relative path via PTY initial cwd", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      stat: makeStat(new Set(["/cwd/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/cwd" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/cwd/src/foo.ts" });
  });

  it("falls through to workspace folder when cwd misses", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      stat: makeStat(new Set(["/ws/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/ws/src/foo.ts" });
  });

  it("treats a directory as a miss and continues", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      stat: makeStat(new Set(["/ws/src/foo.ts"]), new Set(["/cwd/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/ws/src/foo.ts" });
  });

  it("falls through to workspace when getInitialCwd returns undefined", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => undefined),
      stat: makeStat(new Set(["/ws/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });
});

describe("openFileLink: file-not-found", () => {
  it("shows error toast and does not open when no candidate resolves", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set()),
    });
    await openFileLink(msg({ path: "src/missing.ts" }), deps);
    expect(deps.showError).toHaveBeenCalledWith("File not found: src/missing.ts");
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });
});

describe("openFileLink: out-of-scope confirm", () => {
  it("shows modal warning when resolved path is outside cwd + workspace", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/outside/foo.ts"])),
      showWarning: vi.fn(async () => "Cancel"),
    });
    await openFileLink(msg({ path: "/outside/foo.ts" }), deps);
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    const [body, opts, ...buttons] = (deps.showWarning as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(body).toContain("Open file outside workspace?");
    expect(body).toContain("/outside/foo.ts");
    expect(opts).toEqual({ modal: true });
    expect(buttons).toEqual(["Open", "Cancel"]);
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("opens when user picks 'Open' on the modal", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/outside/foo.ts"])),
      showWarning: vi.fn(async () => "Open" as unknown as undefined),
    });
    await openFileLink(msg({ path: "/outside/foo.ts" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("does NOT show warning when path is exactly a workspace folder root", async () => {
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws"])),
      showWarning: vi.fn(),
    });
    await openFileLink(msg({ path: "/ws" }), deps);
    // Either it opens (treated as inside) or it can fall through — the
    // critical assertion is the warning didn't appear because path equals base.
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it("does NOT show warning when path is inside workspace", async () => {
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws/src/foo.ts"])),
    });
    await openFileLink(msg({ path: "/ws/src/foo.ts" }), deps);
    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });
});

describe("openFileLink: selection from line/col", () => {
  it("passes Range(line-1, col-1) when both provided", async () => {
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws/foo.ts"])),
    });
    await openFileLink(msg({ path: "/ws/foo.ts", line: 42, col: 7 }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toBeDefined();
    const range = (calls[0][1] as { selection: vscode.Range }).selection;
    expect(range.start).toEqual({ line: 41, character: 6 });
    expect(range.end).toEqual({ line: 41, character: 6 });
  });

  it("passes Range(line-1, 0) when only line provided", async () => {
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws/foo.ts"])),
    });
    await openFileLink(msg({ path: "/ws/foo.ts", line: 42 }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    const range = (calls[0][1] as { selection: vscode.Range }).selection;
    expect(range.start).toEqual({ line: 41, character: 0 });
  });

  it("omits selection arg when neither line nor col provided", async () => {
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws/foo.ts"])),
    });
    await openFileLink(msg({ path: "/ws/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toBeUndefined();
  });
});

describe("openFileLink: stat error handling", () => {
  it("logs unexpected (non-FileNotFound) stat errors and falls through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: vi.fn(async (uri: vscode.Uri) => {
        if (uri.fsPath === "/ws/foo.ts") {
          return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 };
        }
        const err = new Error("EACCES") as Error & { code: string };
        err.code = "NoPermissions";
        throw err;
      }),
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    // Logged the permission error on /cwd/foo.ts
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stat(/cwd/foo.ts)"), expect.any(Error));
    // Still opened the file via workspace fallback
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does NOT log FileNotFound errors (common case)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws/foo.ts"])),
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("openFileLink: defensive", () => {
  it("does nothing for empty path", async () => {
    const deps = makeDeps({ stat: makeStat(new Set()) });
    await openFileLink(msg({ path: "" }), deps);
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("normalizes paths before resolution (eats .. segments) and confirms when outside cwd", async () => {
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd/a"),
      stat: makeStat(new Set(["/cwd/b/foo.ts"])),
      // user clicks "Open" on the out-of-scope confirm
      showWarning: vi.fn(async () => "Open" as unknown as undefined),
    });
    await openFileLink(msg({ path: "../b/foo.ts" }), deps);
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    // path.join("/cwd/a", "../b/foo.ts") normalizes to "/cwd/b/foo.ts".
    expect(path.posix.normalize((calls[0][0] as { fsPath: string }).fsPath)).toBe("/cwd/b/foo.ts");
  });
});
