// Sidebar/panel cross-restart restore path.
// See: asimov/changes/restore-terminal-sessions/specs/cross-restart-session-restore/spec.md

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";

vi.mock("../pty/PtyManager", () => ({
  loadNodePty: vi.fn(() => ({
    spawn: vi.fn(() => ({
      onData: vi.fn(() => ({ dispose: () => {} })),
      onExit: vi.fn(() => ({ dispose: () => {} })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      pid: 12345,
    })),
  })),
  detectShell: vi.fn(() => ({ shell: "/bin/zsh", args: ["--login"] })),
  buildEnvironment: vi.fn(() => ({ PATH: "/usr/bin" })),
  resolveWorkingDirectory: vi.fn(() => "/tmp"),
}));

vi.mock("../pty/PtySession", () => {
  class MockPtySession {
    id: string;
    pid = 99000;
    spawn = vi.fn();
    write = vi.fn();
    resize = vi.fn();
    kill = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    setCurrentCwdSink = vi.fn();
    onData: any = undefined;
    onExit: any = undefined;
    constructor(id: string) {
      this.id = id;
    }
  }
  return { PtySession: MockPtySession };
});

vi.mock("../session/OutputBuffer", () => {
  class MockOutputBuffer {
    append = vi.fn();
    dispose = vi.fn();
    updateWebview = vi.fn();
    pauseOutput = vi.fn();
    resumeOutput = vi.fn();
    handleAck = vi.fn();
    flush = vi.fn();
    bufferSize = 0;
    unackedCharCount = 0;
    constructor(
      public _i: string,
      public _w: unknown,
      public _p: unknown,
    ) {}
  }
  return { OutputBuffer: MockOutputBuffer };
});

import type * as vscode from "vscode";
import { SessionManager } from "../session/SessionManager";
import type { PendingSnapshot } from "../session/SessionSnapshot";
import { TerminalViewProvider } from "./TerminalViewProvider";

function pendingSnap(sessionId: string, location: "sidebar" | "panel"): PendingSnapshot {
  return {
    metadata: {
      sessionId,
      viewLocation: location,
      terminalNumber: 1,
      customName: null,
      shell: "/bin/zsh",
      shellArgs: [],
      cwd: "/home",
      currentCwd: null,
      cols: 100,
      rows: 30,
      bufferFile: `snapshots/${sessionId}.snapshot.ans`,
      bufferBytes: 4,
      isSplitPane: false,
      rootTabId: sessionId,
      snapshotAt: 1700000000000,
      shellExited: false,
      exitCode: null,
    },
    buffer: "DATA",
  };
}

function createMockWebviewView() {
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const postMessage = vi.fn((_msg: unknown) => Promise.resolve(true));
  const webviewView = {
    visible: true,
    viewType: "anywhereTerminal.sidebar",
    webview: {
      html: "",
      options: {},
      cspSource: "https://mock.csp.source",
      asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
      onDidReceiveMessage: (handler: (msg: unknown) => void) => {
        messageHandlers.push(handler);
        return { dispose: () => {} };
      },
      postMessage,
    },
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  } as unknown as vscode.WebviewView;
  return { webviewView, messageHandlers, postMessage };
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TerminalViewProvider.onReady restore branch", () => {
  it("creates sessions from staged snapshots and posts init + restoreFromSnapshot", () => {
    const sm = new SessionManager(undefined, { restoreEnabled: true });
    sm.__stagePendingSnapshot(pendingSnap("S1", "sidebar"));
    const provider = new TerminalViewProvider({ fsPath: "/mock/ext" } as vscode.Uri, sm, "sidebar");
    const { webviewView, messageHandlers, postMessage } = createMockWebviewView();
    provider.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    for (const h of messageHandlers) {
      h({ type: "ready" });
    }

    const calls = postMessage.mock.calls.map((c) => c[0] as unknown) as Array<{
      type?: string;
      tabId?: string;
    }>;
    const init = calls.find((m) => m?.type === "init");
    const restore = calls.find((m) => m?.type === "restoreFromSnapshot");
    expect(init).toBeDefined();
    expect(restore).toBeDefined();
    expect(restore!.tabId).toBe("S1");
    expect(sm.getTabsForView(provider.getViewId())).toHaveLength(1);
    sm.dispose();
  });

  it("does NOT take the restore branch when sessions already exist (existingTabs takes precedence)", () => {
    const sm = new SessionManager(undefined, { restoreEnabled: true });
    const provider = new TerminalViewProvider({ fsPath: "/mock/ext" } as vscode.Uri, sm, "sidebar");
    const { webviewView, messageHandlers, postMessage } = createMockWebviewView();
    provider.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    // Pre-create one session so existingTabs.length > 0.
    sm.createSession(provider.getViewId(), webviewView.webview);

    // Stage snapshot but it should NOT be consumed.
    sm.__stagePendingSnapshot(pendingSnap("X", "sidebar"));
    for (const h of messageHandlers) {
      h({ type: "ready" });
    }

    const calls = postMessage.mock.calls.map((c) => c[0] as unknown) as Array<{
      type?: string;
      tabId?: string;
    }>;
    const restore = calls.find((m) => m?.type === "restoreFromSnapshot");
    expect(restore).toBeUndefined();
    // Snapshot still staged
    expect(sm.hasSnapshotsForLocation("sidebar")).toBe(true);
    sm.dispose();
  });
});
