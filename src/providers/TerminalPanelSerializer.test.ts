// TerminalPanelSerializer revival sequence: cancel destroy → consume → construct.
// See: asimov/changes/restore-terminal-sessions/specs/editor-tab-reload-resilience/spec.md

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../session/SessionManager";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";
import { TerminalEditorProvider } from "./TerminalEditorProvider";
import { TerminalPanelSerializer } from "./TerminalPanelSerializer";

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

describe("TerminalPanelSerializer.deserializeWebviewPanel", () => {
  it("cancels the scheduled destroy and consumes snapshots before constructing a new provider", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const cancelSpy = vi.spyOn(sm, "cancelScheduledDestroy");
    const consumeSpy = vi.spyOn(sm, "consumeSnapshotsForPanel");
    const reviveSpy = vi.spyOn(TerminalEditorProvider, "revive");

    const vscode = await import("vscode");
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");
    // Create a panel via the public API so the mock returns a usable shape.
    TerminalEditorProvider.createPanel(ctx, sm);
    const panel = createSpy.mock.results[0].value;

    const serializer = new TerminalPanelSerializer(ctx, sm, null, null);
    await serializer.deserializeWebviewPanel(panel, { panelId: "P-RESTORED" });

    // All three actions fire in the correct order: cancel BEFORE consume BEFORE revive.
    expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(consumeSpy.mock.invocationCallOrder[0]);
    expect(consumeSpy.mock.invocationCallOrder[0]).toBeLessThan(reviveSpy.mock.invocationCallOrder[0]);
    expect(cancelSpy).toHaveBeenCalledWith("editor-P-RESTORED");
    expect(consumeSpy).toHaveBeenCalledWith("P-RESTORED");
    expect(reviveSpy.mock.calls[0][3]).toBe("P-RESTORED"); // panelId arg

    (panel as any).dispose();
    sm.dispose();
  });

  it("falls back to a fresh UUID when state.panelId is missing (legacy panels)", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const reviveSpy = vi.spyOn(TerminalEditorProvider, "revive");

    const vscode = await import("vscode");
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");
    TerminalEditorProvider.createPanel(ctx, sm);
    const panel = createSpy.mock.results[0].value;

    const serializer = new TerminalPanelSerializer(ctx, sm, null, null);
    await serializer.deserializeWebviewPanel(panel, null);

    const passedPanelId = reviveSpy.mock.calls[0][3] as string;
    expect(typeof passedPanelId).toBe("string");
    expect(passedPanelId.length).toBeGreaterThan(0);

    (panel as any).dispose();
    sm.dispose();
  });
});
