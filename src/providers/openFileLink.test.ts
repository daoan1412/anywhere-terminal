// src/providers/openFileLink.test.ts — Unit tests for openFileLink.

import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { OpenFileMessage } from "../types/messages";
import { escapeGlob, type OpenFileLinkDeps, openFileLink } from "./openFileLink";

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
    getCurrentCwd: vi.fn(() => undefined),
    getLiveCwd: vi.fn(async () => undefined),
    workspaceFolders: undefined,
    stat: makeStat(new Set()),
    findFiles: vi.fn(async () => []),
    showWarning: vi.fn(),
    showError: vi.fn(),
    showTextDocument: vi.fn(),
    showQuickPick: vi.fn(async () => undefined),
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

// ─── Path resolution chain: liveCwd (PID-based) is step 2, ahead of currentCwd ──

describe("openFileLink: liveCwd resolution (step 2)", () => {
  it("liveCwd hit short-circuits before currentCwd and initialCwd", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/live"),
      getCurrentCwd: vi.fn(() => "/osc"),
      getInitialCwd: vi.fn(() => "/init"),
      // All three would resolve; liveCwd must win.
      stat: makeStat(new Set(["/live/src/foo.ts", "/osc/src/foo.ts", "/init/src/foo.ts"])),
      // Put /live in workspace so the trust-boundary check doesn't fire.
      workspaceFolders: [{ uri: { fsPath: "/live" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/live/src/foo.ts" });
  });

  it("liveCwd undefined falls through to currentCwd", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => undefined),
      getCurrentCwd: vi.fn(() => "/osc"),
      stat: makeStat(new Set(["/osc/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/osc" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/osc/src/foo.ts" });
  });

  it("liveCwd that throws is treated as undefined (no crash, fall through)", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => {
        throw new Error("query failed");
      }),
      getInitialCwd: vi.fn(() => "/init"),
      stat: makeStat(new Set(["/init/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/init" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("works without getLiveCwd deps (optional field, backwards compat)", async () => {
    // Build deps WITHOUT getLiveCwd to lock the optional contract.
    const deps: OpenFileLinkDeps = {
      getInitialCwd: vi.fn(() => "/init"),
      getCurrentCwd: vi.fn(() => undefined),
      // getLiveCwd intentionally omitted
      workspaceFolders: [{ uri: { fsPath: "/init" } }],
      stat: makeStat(new Set(["/init/src/foo.ts"])),
      findFiles: vi.fn(async () => []),
      showWarning: vi.fn(),
      showError: vi.fn(),
      showTextDocument: vi.fn(),
      showQuickPick: vi.fn(async () => undefined) as unknown as OpenFileLinkDeps["showQuickPick"],
    };
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("SECURITY: liveCwd is NOT a trust base — modal fires when liveCwd-resolved path is outside initialCwd/workspace", async () => {
    // The shell-side process can change its cwd to anywhere; including
    // liveCwd in the modal's "bases" would let any process running in the
    // terminal silently disable the out-of-workspace prompt. This test
    // locks that invariant.
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/outside"),
      // initialCwd + workspace are the ONLY trust roots; neither contains /outside.
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/outside/secret.ts"])),
      showWarning: vi.fn(async () => "Cancel"),
    });
    await openFileLink(msg({ path: "secret.ts" }), deps);
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("getLiveCwd is invoked exactly once per call (no per-candidate spam)", async () => {
    const getLiveCwd = vi.fn(async () => "/live");
    const deps = makeDeps({
      getLiveCwd,
      stat: makeStat(new Set(["/live/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/live" } }],
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(getLiveCwd).toHaveBeenCalledTimes(1);
  });
});

// ─── Path resolution chain: currentCwd inserted between absolute and initialCwd ───

describe("openFileLink: currentCwd resolution", () => {
  it("(a) currentCwd hit short-circuits before initialCwd even when initialCwd would also resolve", async () => {
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => "/proj"),
      getInitialCwd: vi.fn(() => "/init"),
      // Both /proj/src/foo.ts AND /init/src/foo.ts exist — currentCwd must win.
      stat: makeStat(new Set(["/proj/src/foo.ts", "/init/src/foo.ts"])),
      // Put /proj in workspace so the resolved path passes the trust boundary
      // without triggering the modal (we're testing resolution order here, not
      // the security check).
      workspaceFolders: [{ uri: { fsPath: "/proj" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/proj/src/foo.ts" });
  });

  it("(b) currentCwd undefined falls through to initialCwd", async () => {
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => undefined),
      getInitialCwd: vi.fn(() => "/init"),
      stat: makeStat(new Set(["/init/src/foo.ts"])),
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/init/src/foo.ts" });
  });

  it("currentCwd miss falls through to initialCwd then workspace", async () => {
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => "/proj"),
      getInitialCwd: vi.fn(() => "/init"),
      // Only the workspace candidate exists.
      stat: makeStat(new Set(["/ws/src/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/ws/src/foo.ts" });
  });

  it("currentCwd is NOT a trust base — modal still fires when path is outside initialCwd/workspace", async () => {
    // SECURITY regression test: shell-controlled currentCwd must not weaken
    // the out-of-workspace confirm boundary. A hostile OSC 7 emit could
    // otherwise silently disable the modal for arbitrary file opens.
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => "/proj"),
      // No initialCwd, no workspaceFolders — only currentCwd is set.
      getInitialCwd: vi.fn(() => undefined),
      workspaceFolders: undefined,
      stat: makeStat(new Set(["/proj/src/foo.ts"])),
      showWarning: vi.fn(async () => "Cancel"),
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    // Modal fires because /proj is NOT in trust bases (only initialCwd +
    // workspaceFolders are). User cancelled → no open.
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("does NOT trigger out-of-workspace confirm when initialCwd contains the resolved path (even when currentCwd also matches)", async () => {
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => "/proj"),
      getInitialCwd: vi.fn(() => "/proj"),
      stat: makeStat(new Set(["/proj/src/foo.ts"])),
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });
});

// ─── findFiles fallback ─────────────────────────────────────────────

describe("openFileLink: findFiles fallback", () => {
  it("(c) when all stat candidates miss, findFiles returns 1 match and opens it", async () => {
    const findFiles = vi.fn(async () => [{ fsPath: "/discovered/src/foo.ts" }] as unknown as vscode.Uri[]);
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set()),
      findFiles,
      // path is outside our bases — confirm fires; auto-approve in test.
      showWarning: vi.fn(async () => "Open" as unknown as undefined),
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatchObject({ fsPath: "/discovered/src/foo.ts" });
  });

  it("(d) when findFiles returns 0 matches, shows 'File not found' toast", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set()),
      findFiles: vi.fn(async () => []),
    });
    await openFileLink(msg({ path: "src/missing.ts" }), deps);
    expect(deps.showError).toHaveBeenCalledWith("File not found: src/missing.ts");
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("(e) findFiles called with **/-prefixed pattern, the exclude glob, and maxResults=50", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    // After the basename-fallback addition (design D6), a clicked path
    // with a separator triggers TWO findFiles calls when the first returns
    // 0: full-path glob, then basename glob with endsWithPath filter.
    expect(findFiles).toHaveBeenCalledTimes(2);
    expect(findFiles).toHaveBeenNthCalledWith(
      1,
      "**/src/foo.ts",
      "{**/node_modules/**,**/.git/**}",
      50,
      expect.anything(),
    );
    expect(findFiles).toHaveBeenNthCalledWith(2, "**/foo.ts", "{**/node_modules/**,**/.git/**}", 50, expect.anything());
  });

  it("(f) findFiles throws → console.warn + 'File not found' toast", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles: vi.fn(async () => {
        throw new Error("workspace closed");
      }),
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("findFiles fallback failed"), expect.any(Error));
    expect(deps.showError).toHaveBeenCalledWith("File not found: src/foo.ts");
    expect(deps.showTextDocument).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("(g) absolute paths short-circuit — findFiles is NOT called", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set(["/abs/foo.ts"])),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "/abs/foo.ts" }), deps);
    expect(findFiles).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("(h) glob meta chars in path are escaped before passing to findFiles", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "foo[1]*.ts" }), deps);
    // Each meta char wrapped in [...] literal char-class — escapeGlob spec.
    expect(findFiles).toHaveBeenCalledWith("**/foo[[]1[]][*].ts", expect.any(String), 50, expect.anything());
  });

  it("(h) escapeGlob handles all five meta sets correctly", () => {
    expect(escapeGlob("a[1]*.ts")).toBe("a[[]1[]][*].ts");
    expect(escapeGlob("a{b}c?.ts")).toBe("a[{]b[}]c[?].ts");
    expect(escapeGlob("plain.txt")).toBe("plain.txt");
  });

  it("(i) findFiles that never resolves times out at 2000ms → console.warn + not-found toast", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const findFiles = vi.fn(() => new Promise<vscode.Uri[]>(() => {})); // never resolves
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    const pending = openFileLink(msg({ path: "src/never.ts" }), deps);
    // Advance fake clock past the 2000ms budget. flushMicrotasks lets pending
    // microtasks (e.g. error rejection chains) finish before assertion.
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("findFiles fallback failed"), expect.any(Error));
    expect(deps.showError).toHaveBeenCalledWith("File not found: src/never.ts");
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("does NOT call findFiles when msg.path is absolute and stat missed (would be a dead-end glob)", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      findFiles,
    });
    await openFileLink(msg({ path: "/abs/missing.ts" }), deps);
    expect(findFiles).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("File not found: /abs/missing.ts");
  });

  it("does NOT call findFiles when msg.path contains `..` traversal segments", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      findFiles,
    });
    await openFileLink(msg({ path: "../etc/passwd" }), deps);
    expect(findFiles).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("File not found: ../etc/passwd");
  });

  it("calls findFiles with default maxResults=50 (cap for quickPick disambiguation)", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 50, expect.anything());
  });

  it("respects getFileSearchMaxResults override (e.g. user bumped setting to 200)", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      getFileSearchMaxResults: () => 200,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 200, expect.anything());
  });

  it("clamps maxResults to ceiling=1000 when setting is unreasonably high", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      getFileSearchMaxResults: () => 999999,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 1000, expect.anything());
  });

  it("clamps maxResults to minimum=1 when setting is 0 or negative", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      getFileSearchMaxResults: () => -5,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 1, expect.anything());
  });

  it("falls back to default when setting returns NaN", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      getFileSearchMaxResults: () => Number.NaN,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 50, expect.anything());
  });

  it("falls back to default when setting returns Infinity", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      getFileSearchMaxResults: () => Number.POSITIVE_INFINITY,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 50, expect.anything());
  });

  it("falls back to default when getFileSearchMaxResults THROWS (provider misconfig)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      getFileSearchMaxResults: () => {
        throw new Error("config load failed");
      },
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledWith("**/foo.ts", expect.any(String), 50, expect.anything());
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("getFileSearchMaxResults threw, using default"),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("cancels the underlying findFiles token when the 2s timeout expires", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let receivedToken: vscode.CancellationToken | undefined;
    const findFiles = vi.fn((_inc, _exc, _max, token: vscode.CancellationToken | undefined) => {
      receivedToken = token;
      return new Promise<vscode.Uri[]>(() => {}); // never resolves
    });
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    const pending = openFileLink(msg({ path: "slow.ts" }), deps);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(receivedToken).toBeDefined();
    // The token source got cancelled by the timeout — `findFiles` would
    // observe this and stop walking the filesystem.
    expect(receivedToken?.isCancellationRequested).toBe(true);
    warn.mockRestore();
    vi.useRealTimers();
  });
});

// ─── No-workspace findFiles fallback (RelativePattern rooted at cwd) ───
//
// When VS Code is open without any workspace folder (single-file window or
// "no folder open"), workspaceFolders is empty and a bare string glob has
// nothing to search. RelativePattern lets us anchor the search at the PTY's
// live or initial cwd so the user can still click paths and find files.

describe("openFileLink: findFiles without a workspace open", () => {
  it("no workspace + liveCwd → findFiles called with RelativePattern rooted at liveCwd", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/Users/me/proj"),
      stat: makeStat(new Set()),
      workspaceFolders: undefined,
      findFiles,
    });
    await openFileLink(msg({ path: "REQUIREMENT.md" }), deps);
    expect(findFiles).toHaveBeenCalledTimes(1);
    const [pattern] = (findFiles as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pattern).toBeInstanceOf(vscode.RelativePattern);
    expect((pattern as vscode.RelativePattern).baseUri.fsPath).toBe("/Users/me/proj");
    expect((pattern as vscode.RelativePattern).pattern).toBe("**/REQUIREMENT.md");
  });

  it("no workspace + initialCwd (no liveCwd) → RelativePattern rooted at initialCwd", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => undefined),
      getInitialCwd: vi.fn(() => "/Users/me/init"),
      stat: makeStat(new Set()),
      workspaceFolders: undefined,
      findFiles,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).toHaveBeenCalledTimes(1);
    const [pattern] = (findFiles as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pattern).toBeInstanceOf(vscode.RelativePattern);
    expect((pattern as vscode.RelativePattern).baseUri.fsPath).toBe("/Users/me/init");
  });

  it("no workspace + no cwd → findFiles is NOT called, shows 'File not found'", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: undefined,
      findFiles,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    expect(findFiles).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("File not found: foo.ts");
  });

  it("no workspace + liveCwd + match → opens it (modal fires if outside trust bases)", async () => {
    const findFiles = vi.fn(async () => [{ fsPath: "/Users/me/proj/sub/REQUIREMENT.md" }] as unknown as vscode.Uri[]);
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/Users/me/proj"),
      stat: makeStat(new Set()),
      workspaceFolders: undefined,
      findFiles,
      // liveCwd is NOT a trust base, no initialCwd either, no workspace.
      // Resolved path is outside all trust bases → modal fires; user picks "Open".
      showWarning: vi.fn(async () => "Open" as unknown as undefined),
    });
    await openFileLink(msg({ path: "REQUIREMENT.md" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatchObject({ fsPath: "/Users/me/proj/sub/REQUIREMENT.md" });
  });

  it("empty workspaceFolders array (length 0) is treated the same as undefined", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/cwd"),
      workspaceFolders: [], // empty array, not undefined
      stat: makeStat(new Set()),
      findFiles,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    const [pattern] = (findFiles as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pattern).toBeInstanceOf(vscode.RelativePattern);
    expect((pattern as vscode.RelativePattern).baseUri.fsPath).toBe("/cwd");
  });

  it("workspace open → still uses plain string glob (RelativePattern only for no-workspace)", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set()),
      findFiles,
    });
    await openFileLink(msg({ path: "foo.ts" }), deps);
    const [pattern] = (findFiles as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof pattern).toBe("string");
    expect(pattern).toBe("**/foo.ts");
  });
});

// ─── QuickPick disambiguation for ≥2 findFiles matches ──────────────

describe("openFileLink: quickPick disambiguation", () => {
  it("≥2 matches → showQuickPick is invoked; selecting one opens that path", async () => {
    const matches = [{ fsPath: "/ws/a/util.ts" }, { fsPath: "/ws/b/util.ts" }] as unknown as vscode.Uri[];
    const showQuickPick = vi.fn(
      async (items: readonly { label: string; description: string; fsPath: string }[]) => items[1],
    ) as unknown as OpenFileLinkDeps["showQuickPick"];
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles: vi.fn(async () => matches),
      showQuickPick,
    });
    await openFileLink(msg({ path: "util.ts" }), deps);
    expect(showQuickPick).toHaveBeenCalledTimes(1);
    const [items, options] = (showQuickPick as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(items).toEqual([
      { label: "a/util.ts", description: "/ws/a/util.ts", fsPath: "/ws/a/util.ts" },
      { label: "b/util.ts", description: "/ws/b/util.ts", fsPath: "/ws/b/util.ts" },
    ]);
    expect(options).toMatchObject({ placeHolder: expect.stringContaining("2 files match") });
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
    const opened = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opened).toMatchObject({ fsPath: "/ws/b/util.ts" });
  });

  it("≥2 matches + user cancels quickPick → silent no-op (no error toast)", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles: vi.fn(
        async () => [{ fsPath: "/ws/a/util.ts" }, { fsPath: "/ws/b/util.ts" }] as unknown as vscode.Uri[],
      ),
      showQuickPick: vi.fn(async () => undefined) as unknown as OpenFileLinkDeps["showQuickPick"],
    });
    await openFileLink(msg({ path: "util.ts" }), deps);
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("multi-root workspace: label prefixed with folder basename", async () => {
    const showQuickPick = vi.fn(async () => undefined) as unknown as OpenFileLinkDeps["showQuickPick"];
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/repos/foo" } }, { uri: { fsPath: "/repos/bar" } }],
      findFiles: vi.fn(
        async () =>
          [{ fsPath: "/repos/foo/lib/util.ts" }, { fsPath: "/repos/bar/lib/util.ts" }] as unknown as vscode.Uri[],
      ),
      showQuickPick,
    });
    await openFileLink(msg({ path: "lib/util.ts" }), deps);
    const items = (showQuickPick as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      label: string;
      description: string;
    }[];
    expect(items[0].label).toBe("foo/lib/util.ts");
    expect(items[1].label).toBe("bar/lib/util.ts");
  });

  it("1 match still opens directly (no quickPick)", async () => {
    const showQuickPick = vi.fn(async () => undefined) as unknown as OpenFileLinkDeps["showQuickPick"];
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles: vi.fn(async () => [{ fsPath: "/ws/lib/util.ts" }] as unknown as vscode.Uri[]),
      showQuickPick,
    });
    await openFileLink(msg({ path: "lib/util.ts" }), deps);
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("falls back to absolute path label when match is outside all workspace folders", async () => {
    // Defensive — findFiles is workspace-constrained, so this is unlikely
    // in practice, but exercising the fallback locks the contract.
    const showQuickPick = vi.fn(async () => undefined) as unknown as OpenFileLinkDeps["showQuickPick"];
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles: vi.fn(
        async () => [{ fsPath: "/outside/x.ts" }, { fsPath: "/elsewhere/x.ts" }] as unknown as vscode.Uri[],
      ),
      showQuickPick,
    });
    await openFileLink(msg({ path: "x.ts" }), deps);
    const items = (showQuickPick as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as { label: string }[];
    expect(items[0].label).toBe("/outside/x.ts");
    expect(items[1].label).toBe("/elsewhere/x.ts");
  });
});

describe("openFileLink: trailing-slash path", () => {
  it("trailing slash → silent abort before stat or findFiles is called", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set()),
      findFiles,
    });
    await openFileLink(msg({ path: "external-research/" }), deps);
    expect(deps.stat).not.toHaveBeenCalled();
    expect(findFiles).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showTextDocument).not.toHaveBeenCalled();
  });

  it("trailing backslash (Windows-style) → silent abort", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      stat: makeStat(new Set()),
      findFiles,
    });
    await openFileLink(msg({ path: "src\\providers\\" }), deps);
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
  });
});

describe("openFileLink: directory click", () => {
  it("silent abort when ONLY candidate is a directory (no toast, no findFiles)", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      stat: makeStat(new Set(), new Set(["/cwd/src/providers"])),
      findFiles,
    });
    await openFileLink(msg({ path: "src/providers" }), deps);
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showTextDocument).not.toHaveBeenCalled();
    expect(findFiles).not.toHaveBeenCalled();
  });

  it("silent abort when directory matches at multiple candidates", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(), new Set(["/cwd/src/providers", "/ws/src/providers"])),
      findFiles,
    });
    await openFileLink(msg({ path: "src/providers" }), deps);
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showTextDocument).not.toHaveBeenCalled();
    expect(findFiles).not.toHaveBeenCalled();
  });

  it("file in workspace still wins when same name is a directory in cwd (existing behavior)", async () => {
    // Regression guard: don't break the dir-then-file case.
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      stat: makeStat(new Set(["/ws/src/foo.ts"]), new Set(["/cwd/src/foo.ts"])),
    });
    await openFileLink(msg({ path: "src/foo.ts" }), deps);
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatchObject({ fsPath: "/ws/src/foo.ts" });
  });

  it("file-not-found still shows toast when NO candidate (file or dir) resolves", async () => {
    // Regression guard: ensure we didn't suppress the legitimate not-found case.
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      stat: makeStat(new Set()),
      findFiles: vi.fn(async () => []),
    });
    await openFileLink(msg({ path: "src/missing.ts" }), deps);
    expect(deps.showError).toHaveBeenCalledWith("File not found: src/missing.ts");
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

// ─────────────────────────────────────────────────────────────────────
// 4_1 — cwd-suffix duplication (the originally reported bug #1)
// ─────────────────────────────────────────────────────────────────────

describe("openFileLink: cwd-suffix fan-out (bug #1)", () => {
  it("liveCwd=/x/y/a + click a/file.md, file at /x/y/a/file.md → opens the stripped candidate", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/x/y/a"),
      stat: makeStat(new Set(["/x/y/a/file.md"])),
      workspaceFolders: [{ uri: { fsPath: "/x/y/a" } }],
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/x/y/a/file.md" });
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("liveCwd=/x/y/a + click a/file.md, file at /x/y/a/a/file.md → first (deeper) candidate wins", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/x/y/a"),
      stat: makeStat(new Set(["/x/y/a/a/file.md"])),
      workspaceFolders: [{ uri: { fsPath: "/x/y/a" } }],
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/x/y/a/a/file.md" });
  });

  it("currentCwd (OSC 7/633) drives the fan-out same as liveCwd", async () => {
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => "/x/y/a"),
      stat: makeStat(new Set(["/x/y/a/file.md"])),
      workspaceFolders: [{ uri: { fsPath: "/x/y/a" } }],
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("multi-root workspace fans out across each folder", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set(["/p2/a/file.md"])),
      workspaceFolders: [{ uri: { fsPath: "/p1" } }, { uri: { fsPath: "/p2/a" } }],
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/p2/a/file.md" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4_2 — tilde + file:// URI handling
// ─────────────────────────────────────────────────────────────────────

describe("openFileLink: tilde + file:// (design D4, D5)", () => {
  it("~/foo.md resolves under os.homedir()", async () => {
    const home = process.env.HOME || "/home/test";
    const deps = makeDeps({
      stat: makeStat(new Set([`${home}/foo.md`])),
      workspaceFolders: [{ uri: { fsPath: home } }],
    });
    await openFileLink(msg({ path: "~/foo.md" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: `${home}/foo.md` });
  });

  it("file:///abs/foo.md → opens /abs/foo.md", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set(["/abs/foo.md"])),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
    });
    await openFileLink(msg({ path: "file:///abs/foo.md" }), deps);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("file:///abs/foo%20bar.md → opens /abs/foo bar.md (percent-decoded)", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set(["/abs/foo bar.md"])),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
    });
    await openFileLink(msg({ path: "file:///abs/foo%20bar.md" }), deps);
    const calls = (deps.showTextDocument as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ fsPath: "/abs/foo bar.md" });
  });

  it("malformed file://garbage → 'File not found' toast (no stat, no findFiles)", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
    });
    await openFileLink(msg({ path: "file://garbage" }), deps);
    // Pre-transform returned passthrough-malformed → buildCandidates returns []
    // with malformed=true → no stat, no findFiles, straight to "File not found".
    // (Round-1 review W3: previously the findFiles block would enter with a
    // bogus glob like `**/file:[/][/]garbage` — fixed by the `malformed` gate.)
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.findFiles).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("File not found: file://garbage");
  });

  it("UNC injection blocked: file://attacker.example.com/share/x.md → 'File not found' (no SMB stat)", async () => {
    // Round-1 review W1: prevents Windows UNC SMB egress.
    const deps = makeDeps({
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
    });
    await openFileLink(msg({ path: "file://attacker.example.com/share/x.md" }), deps);
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.findFiles).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("File not found: file://attacker.example.com/share/x.md");
  });

  it("file:///abs/foo.md?x=1 → 'File not found' (query rejected)", async () => {
    const deps = makeDeps({
      stat: makeStat(new Set(["/abs/foo.md"])),
      workspaceFolders: [{ uri: { fsPath: "/abs" } }],
    });
    await openFileLink(msg({ path: "file:///abs/foo.md?x=1" }), deps);
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith("File not found: file:///abs/foo.md?x=1");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4_3 — basename fallback in findFiles (design D6)
// ─────────────────────────────────────────────────────────────────────

describe("openFileLink: findFiles basename fallback (design D6)", () => {
  it("first call 0 matches, basename call 3 matches with 1 ending-match → opens that one (no quickPick)", async () => {
    const calls: vscode.GlobPattern[] = [];
    const findFiles = vi.fn(async (include: vscode.GlobPattern) => {
      calls.push(include);
      if (calls.length === 1) {
        // Full-path glob `**/a/file.md` → 0 matches
        return [];
      }
      // Basename glob `**/file.md` → 3 matches, only one ends with /a/file.md
      return [
        { fsPath: "/ws/x/file.md" },
        { fsPath: "/ws/y/file.md" },
        { fsPath: "/ws/sub/a/file.md" },
      ] as vscode.Uri[];
    });
    const deps = makeDeps({
      stat: makeStat(new Set(["/ws/sub/a/file.md"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    expect(findFiles).toHaveBeenCalledTimes(2);
    expect(findFiles).toHaveBeenNthCalledWith(
      1,
      "**/a/file.md",
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
    expect(findFiles).toHaveBeenNthCalledWith(
      2,
      "**/file.md",
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
    expect(deps.showQuickPick).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("basename call returns 2 ending-matches → quickPick is shown", async () => {
    const findFiles = vi
      .fn()
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ fsPath: "/ws/foo/a/file.md" }, { fsPath: "/ws/bar/a/file.md" }]);
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
      showQuickPick: vi.fn(async () => undefined),
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    expect(deps.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("first call returns ≥1 → does NOT issue the basename query (skips fallback)", async () => {
    // stat misses every candidate so findFiles runs. First findFiles call
    // returns 1 match → we open it without a second call.
    const findFiles = vi
      .fn()
      .mockImplementationOnce(async () => [{ fsPath: "/ws/somewhere/a/file.md" }] as vscode.Uri[])
      .mockImplementationOnce(async () => {
        throw new Error("basename should NOT be called");
      });
    const deps = makeDeps({
      // No stat hits — forces fallthrough to findFiles
      stat: makeStat(new Set()),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("single-segment path skips basename fallback (path === basename)", async () => {
    const findFiles = vi.fn(async () => []);
    const deps = makeDeps({
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      findFiles,
    });
    await openFileLink(msg({ path: "foo.md" }), deps);
    // Only the original full-path search runs.
    expect(findFiles).toHaveBeenCalledTimes(1);
    expect(findFiles).toHaveBeenCalledWith("**/foo.md", expect.any(String), expect.any(Number), expect.anything());
  });

  it("no workspace + initialCwd set → RelativePattern reused for basename fallback", async () => {
    const calls: vscode.GlobPattern[] = [];
    const findFiles = vi.fn(async (include: vscode.GlobPattern) => {
      calls.push(include);
      return [];
    });
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      workspaceFolders: undefined,
      findFiles,
    });
    await openFileLink(msg({ path: "a/file.md" }), deps);
    expect(findFiles).toHaveBeenCalledTimes(2);
    // Both calls anchored at /cwd via RelativePattern with the same baseUri.
    const first = calls[0] as vscode.RelativePattern;
    const second = calls[1] as vscode.RelativePattern;
    expect(first.baseUri.fsPath).toBe("/cwd");
    expect(first.pattern).toBe("**/a/file.md");
    expect(second.baseUri.fsPath).toBe("/cwd");
    expect(second.pattern).toBe("**/file.md");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4_4 — symlink-to-directory falls through (design D7)
// ─────────────────────────────────────────────────────────────────────

describe("openFileLink: symlink-to-directory bit mask (design D7)", () => {
  it("FileType.Directory | FileType.SymbolicLink is treated as a directory; falls through silently", async () => {
    const SYMLINK_DIR_TYPE = vscode.FileType.Directory | vscode.FileType.SymbolicLink; // = 66
    const stat = vi.fn(async (uri: vscode.Uri): Promise<vscode.FileStat> => {
      if (uri.fsPath === "/cwd/foo") {
        return { type: SYMLINK_DIR_TYPE, ctime: 0, mtime: 0, size: 0 };
      }
      const err = new Error(`FileNotFound: ${uri.fsPath}`) as Error & { code: string };
      err.code = "FileNotFound";
      throw err;
    });
    const deps = makeDeps({
      getInitialCwd: vi.fn(() => "/cwd"),
      stat,
      workspaceFolders: [{ uri: { fsPath: "/cwd" } }],
    });
    await openFileLink(msg({ path: "foo" }), deps);
    // Should NOT open it as a text doc, should NOT show "File not found" toast
    // (directory click → silent abort), should NOT run findFiles.
    expect(deps.showTextDocument).not.toHaveBeenCalled();
    expect(deps.showError).not.toHaveBeenCalled();
    expect(deps.findFiles).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4_5 — trust-base regression: liveCwd and currentCwd are NOT trust-bases
// ─────────────────────────────────────────────────────────────────────

describe("openFileLink: out-of-scope modal trust bases (security)", () => {
  it("path resolved via liveCwd but outside initialCwd+workspace → modal SHOWN (liveCwd not in trust bases)", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/live"),
      getInitialCwd: vi.fn(() => "/init"),
      stat: makeStat(new Set(["/live/foo.md"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      showWarning: vi.fn(async () => "Cancel"),
    });
    await openFileLink(msg({ path: "foo.md" }), deps);
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
  });

  it("path resolved via currentCwd but outside initialCwd+workspace → modal SHOWN (currentCwd not in trust bases)", async () => {
    const deps = makeDeps({
      getCurrentCwd: vi.fn(() => "/shell-claimed"),
      getInitialCwd: vi.fn(() => "/init"),
      stat: makeStat(new Set(["/shell-claimed/foo.md"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      showWarning: vi.fn(async () => "Cancel"),
    });
    await openFileLink(msg({ path: "foo.md" }), deps);
    expect(deps.showWarning).toHaveBeenCalledTimes(1);
  });

  it("path resolved inside initialCwd → no modal", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/live"),
      getInitialCwd: vi.fn(() => "/init"),
      stat: makeStat(new Set(["/init/foo.md"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      showWarning: vi.fn(),
    });
    await openFileLink(msg({ path: "foo.md" }), deps);
    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it("path resolved inside workspace folder → no modal", async () => {
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/live"),
      getInitialCwd: vi.fn(() => "/init"),
      stat: makeStat(new Set(["/ws/foo.md"])),
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      showWarning: vi.fn(),
    });
    await openFileLink(msg({ path: "foo.md" }), deps);
    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4_6 — dedup across cwd sources (design D2)
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Latent absolute-path concatenation bug (design D8) — was previously
// producing `cwd + absoluteMsgPath` as a second candidate because Node
// `path.join` strips the leading separator of the second arg. The D2
// short-circuit makes absolute paths produce exactly ONE candidate.
// ─────────────────────────────────────────────────────────────────────

describe("openFileLink: absolute path short-circuit (design D8)", () => {
  it("with liveCwd set + absolute msg.path, stat called exactly once on the absolute path", async () => {
    const calledPaths: string[] = [];
    const stat = vi.fn(async (uri: vscode.Uri): Promise<vscode.FileStat> => {
      calledPaths.push(uri.fsPath);
      const err = new Error(`FileNotFound: ${uri.fsPath}`) as Error & { code: string };
      err.code = "FileNotFound";
      throw err;
    });
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/Users/huybuidac/Projects/gmi/arco-contract"),
      getInitialCwd: vi.fn(() => "/Users/huybuidac/Projects/gmi/arco-contract"),
      stat,
      workspaceFolders: [{ uri: { fsPath: "/Users/huybuidac/Projects/gmi/arco-contract" } }],
      findFiles: vi.fn(async () => []),
    });
    await openFileLink(msg({ path: "/Users/huybuidac/Projects/gmi/arco-contract/arco-audit.md" }), deps);
    // Before the D2 short-circuit, candidates included the bogus
    // concatenation `<cwd>/<full-absolute-without-leading-slash>`.
    // After the fix, the absolute branch returns exactly one candidate.
    expect(calledPaths).toEqual(["/Users/huybuidac/Projects/gmi/arco-contract/arco-audit.md"]);
    // findFiles was skipped because msg.path is absolute (per spec).
    expect(deps.findFiles).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith(
      "File not found: /Users/huybuidac/Projects/gmi/arco-contract/arco-audit.md",
    );
  });
});

describe("openFileLink: dedup across cwd sources (design D2)", () => {
  it("identical cwd sources collapse to a single stat call", async () => {
    const stat = vi.fn(async (uri: vscode.Uri): Promise<vscode.FileStat> => {
      if (uri.fsPath === "/same/foo.md") {
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 };
      }
      const err = new Error(`FileNotFound: ${uri.fsPath}`) as Error & { code: string };
      err.code = "FileNotFound";
      throw err;
    });
    const deps = makeDeps({
      getLiveCwd: vi.fn(async () => "/same"),
      getCurrentCwd: vi.fn(() => "/same"),
      getInitialCwd: vi.fn(() => "/same"),
      stat,
      workspaceFolders: [{ uri: { fsPath: "/same" } }, { uri: { fsPath: "/same" } }],
    });
    await openFileLink(msg({ path: "foo.md" }), deps);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(deps.showTextDocument).toHaveBeenCalledTimes(1);
  });
});
