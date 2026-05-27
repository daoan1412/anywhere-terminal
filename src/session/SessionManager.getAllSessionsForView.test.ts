// getAllSessionsForView returns roots AND split-pane children so the webview
// can recreate every xterm referenced by `tabLayouts` on reload / cross-restart.
// See: restore-terminal-sessions design.md D12,
// specs/editor-tab-reload-resilience/spec.md (Split-pane survival in init message).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";

vi.mock("../pty/processCwd", () => ({ queryProcessCwd: vi.fn(async () => undefined) }));
vi.mock("../pty/PtyManager", () => ({
  loadNodePty: vi.fn(() => ({ spawn: vi.fn() })),
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
    setShellIntegrationSink = vi.fn();
    setShellIntegrationNonce = vi.fn();
    onData: unknown = undefined;
    onExit: unknown = undefined;
    constructor(id: string) {
      this.id = id;
    }
  }
  return { PtySession: MockPtySession };
});
vi.mock("./OutputBuffer", () => {
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

import { SessionManager } from "./SessionManager";

const makeWebview = () => ({ postMessage: vi.fn(() => Promise.resolve(true)) });

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionManager.getAllSessionsForView", () => {
  it("returns an empty array for an unknown viewId", () => {
    const sm = new SessionManager();
    expect(sm.getAllSessionsForView("editor-nope")).toEqual([]);
    sm.dispose();
  });

  it("returns root tab AND split-pane children with isSplitPane flag", () => {
    const sm = new SessionManager();
    const viewId = "editor-panel-A";
    const webview = makeWebview();

    const rootId = sm.createSession(viewId, webview, { shell: "/bin/zsh" });
    const splitId = sm.createSession(viewId, webview, { shell: "/bin/zsh", isSplitPane: true });

    const all = sm.getAllSessionsForView(viewId);
    expect(all).toHaveLength(2);

    const root = all.find((s) => s.id === rootId);
    const split = all.find((s) => s.id === splitId);
    expect(root).toBeDefined();
    expect(split).toBeDefined();
    expect(root?.isSplitPane).toBe(false);
    expect(split?.isSplitPane).toBe(true);
    // The split pane must NOT have stolen active status from the root.
    expect(root?.isActive).toBe(true);
    expect(split?.isActive).toBe(false);

    sm.dispose();
  });

  it("returns just the root when the view has no splits (matches getTabsForView for the !isSplitPane subset)", () => {
    const sm = new SessionManager();
    const viewId = "anywhereTerminal.sidebar";
    const webview = makeWebview();

    const rootId = sm.createSession(viewId, webview, { shell: "/bin/zsh" });

    const all = sm.getAllSessionsForView(viewId);
    const tabs = sm.getTabsForView(viewId);

    expect(all.map((s) => s.id)).toEqual([rootId]);
    expect(tabs.map((t) => t.id)).toEqual([rootId]);
    expect(all[0].isSplitPane).toBe(false);

    sm.dispose();
  });
});
