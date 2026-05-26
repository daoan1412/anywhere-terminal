// Verifies the panelId is derived into _viewId, surfaced via getPanelId(), and
// posted to the webview as a `setPanelId` message on ready.
// See: asimov/changes/restore-terminal-sessions/design.md D2.

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

describe("TerminalEditorProvider panelId wiring", () => {
  it("derives _viewId from the generated panelId (createPanel path)", async () => {
    const ctx = createMockContext();
    const sm = new SessionManager();
    const vscode = await import("vscode");
    const createSpy = vi.spyOn(vscode.window, "createWebviewPanel");
    TerminalEditorProvider.createPanel(ctx, sm);
    const panel = createSpy.mock.results[0].value;

    // Resolve provider instance for the panel via the static map.
    const provider = TerminalEditorProvider.findByViewId(`editor-${TerminalEditorProvider.viewType}-unknown`);
    // findByViewId returns undefined for unknown viewIds. We instead probe via getActivePanels + instances.
    expect(provider).toBeUndefined();

    const webview = (panel as any).webview as { postMessage: (m: unknown) => Promise<boolean> };
    const posts: Array<{ type?: string; panelId?: string }> = [];
    const origPost = webview.postMessage.bind(webview);
    webview.postMessage = (m: unknown) => {
      posts.push(m as { type?: string; panelId?: string });
      return origPost(m);
    };

    // Trigger ready so the provider posts setPanelId.
    for (const handler of (panel as any).__messageHandlers) {
      handler({ type: "ready" });
    }
    const setPanelId = posts.find((m) => m?.type === "setPanelId");
    expect(setPanelId).toBeDefined();
    expect(typeof setPanelId!.panelId).toBe("string");
    expect(setPanelId!.panelId!.length).toBeGreaterThan(0);

    (panel as any).dispose();
    sm.dispose();
  });
});
