// Verifies TerminalEditorProvider.onDidDispose schedules destroy (D3) instead of
// destroying sessions immediately.
// See: asimov/changes/restore-terminal-sessions/specs/editor-tab-reload-resilience/spec.md

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session/SessionManager";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import { TerminalEditorProvider } from "./TerminalEditorProvider";

function createMockContext() {
  return {
    extensionUri: { fsPath: "/mock/ext" },
    workspaceState: { get: () => undefined, update: () => Promise.resolve() } as any,
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TerminalEditorProvider.onDidDispose", () => {
  it("calls scheduleDestroyForView instead of destroyAllForView", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const scheduleSpy = vi.spyOn(sm, "scheduleDestroyForView");
    const destroySpy = vi.spyOn(sm, "destroyAllForView");

    const vscode = await import("vscode");
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");
    TerminalEditorProvider.createPanel(ctx, sm);
    const panel = createSpy.mock.results[0].value;

    // Trigger ready so the provider creates a session for this viewId.
    for (const handler of (panel as any).__messageHandlers) {
      handler({ type: "ready" });
    }

    (panel as any).dispose();

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    const firstArg = scheduleSpy.mock.calls[0][0] as string;
    expect(firstArg.startsWith("editor-")).toBe(true);
    expect(scheduleSpy.mock.calls[0][1]).toBe(5000);
    // destroyAllForView is NOT called directly from onDidDispose; it fires later via the timer.
    expect(destroySpy).not.toHaveBeenCalled();
    sm.dispose();
  });
});
