// Editor onReady three-case branching: existing | restore | cold.
// See: asimov/changes/restore-terminal-sessions/specs/editor-tab-reload-resilience/spec.md

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

import { SessionManager } from "../session/SessionManager";
import type { PendingSnapshot } from "../session/SessionSnapshot";
import { TerminalEditorProvider } from "./TerminalEditorProvider";

function createMockContext() {
  return {
    extensionUri: { fsPath: "/mock/ext" },
    workspaceState: { get: () => undefined, update: () => Promise.resolve() } as any,
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

function pendingSnap(sessionId: string, panelId: string): PendingSnapshot {
  return {
    metadata: {
      sessionId,
      panelId,
      viewLocation: "editor",
      terminalNumber: 1,
      customName: null,
      shell: "/bin/zsh",
      shellArgs: [],
      cwd: "/",
      currentCwd: null,
      cols: 80,
      rows: 24,
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

function _instrumentPanel(panel: { webview: { postMessage: (m: unknown) => Promise<boolean> } }) {
  const posts: Array<{ type?: string; tabId?: string }> = [];
  const orig = panel.webview.postMessage.bind(panel.webview);
  panel.webview.postMessage = (m: unknown) => {
    posts.push(m as { type?: string; tabId?: string });
    return orig(m);
  };
  return posts;
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TerminalEditorProvider.onReady three-case branching", () => {
  it("cold-open: createSession + init (no restore messages)", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const vscode = await import("vscode");
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");
    TerminalEditorProvider.createPanel(ctx, sm);
    const panel = createSpy.mock.results[0].value;
    const postSpy = vi.spyOn(panel.webview, "postMessage");

    for (const h of (panel as any).__messageHandlers) {
      h({ type: "ready" });
    }
    const types = postSpy.mock.calls.map((c) => (c[0] as { type?: string })?.type);
    expect(types).toContain("init");
    expect(types).not.toContain("restoreFromSnapshot");
    expect(types).not.toContain("restore");

    (panel as any).dispose();
    sm.dispose();
  });

  it("existing-sessions Phase A: init.tabs includes root + split with isSplitPane flag", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const vscode = await import("vscode");
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");

    // Pre-populate the view as if survival-of-the-grace-window happened: one
    // root tab + one split-pane child both bound to `editor-${panelId}`.
    const panelId = "P-split";
    const viewId = `editor-${panelId}`;
    const fakeWebview = { postMessage: vi.fn(async () => true) } as unknown as Parameters<typeof sm.createSession>[1];
    const rootId = sm.createSession(viewId, fakeWebview, { shell: "/bin/zsh" });
    const splitId = sm.createSession(viewId, fakeWebview, { shell: "/bin/zsh", isSplitPane: true });

    const panel = (
      vscode.window as unknown as {
        createWebviewPanel: (
          t: string,
          n: string,
          c: unknown,
          o: unknown,
        ) => ReturnType<typeof vscode.window.createWebviewPanel>;
      }
    ).createWebviewPanel(TerminalEditorProvider.viewType, "Terminal", 1, {});
    const realPanel = createSpy.mock.results[0]?.value ?? panel;
    const postSpy = vi.spyOn(realPanel.webview, "postMessage");

    TerminalEditorProvider.revive(ctx, sm, realPanel, panelId, []);

    for (const h of (realPanel as any).__messageHandlers) {
      h({ type: "ready" });
    }

    const initCall = postSpy.mock.calls
      .map((c) => c[0] as { type?: string; tabs?: Array<{ id: string; isSplitPane?: boolean }> })
      .find((m) => m?.type === "init");
    expect(initCall).toBeDefined();
    expect(initCall!.tabs).toBeDefined();
    const tabIds = initCall!.tabs!.map((t) => t.id).sort();
    expect(tabIds).toEqual([rootId, splitId].sort());
    const rootTab = initCall!.tabs!.find((t) => t.id === rootId);
    const splitTab = initCall!.tabs!.find((t) => t.id === splitId);
    expect(rootTab?.isSplitPane).toBe(false);
    expect(splitTab?.isSplitPane).toBe(true);

    (realPanel as any).dispose();
    sm.dispose();
  });

  it("restore: revive() with snapshots posts restoreFromSnapshot", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const vscode = await import("vscode");
    // createWebviewPanel mock returns a stand-in we then hand to revive().
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");
    // Use createWebviewPanel directly (NOT createPanel — we don't want the cold-open provider).
    const panel = (
      vscode.window as unknown as {
        createWebviewPanel: (
          t: string,
          n: string,
          c: unknown,
          o: unknown,
        ) => ReturnType<typeof vscode.window.createWebviewPanel>;
      }
    ).createWebviewPanel(TerminalEditorProvider.viewType, "Terminal", 1, {});
    const realPanel = createSpy.mock.results[0]?.value ?? panel;
    const postSpy = vi.spyOn(realPanel.webview, "postMessage");

    const snap = pendingSnap("S1", "P1");
    TerminalEditorProvider.revive(ctx, sm, realPanel, "P1", [snap]);

    for (const h of (realPanel as any).__messageHandlers) {
      h({ type: "ready" });
    }
    // onReady is async now (W1 fix) — await init delivery before the
    // restoreFromSnapshot loop. Flush microtasks so the post-await loop
    // runs before we inspect postSpy.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const types = postSpy.mock.calls.map((c) => (c[0] as { type?: string })?.type);
    expect(types).toContain("init");
    expect(types).toContain("restoreFromSnapshot");
    // Init MUST be posted before restoreFromSnapshot — that's the whole
    // point of the W1 fix.
    const initIdx = types.indexOf("init");
    const restoreIdx = types.indexOf("restoreFromSnapshot");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(restoreIdx).toBeGreaterThan(initIdx);
    const restore = postSpy.mock.calls
      .map((c) => c[0] as { type?: string; tabId?: string })
      .find((m) => m?.type === "restoreFromSnapshot");
    expect(restore!.tabId).toBe("S1");

    (realPanel as any).dispose();
    sm.dispose();
  });
});
