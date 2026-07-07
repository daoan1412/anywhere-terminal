// src/providers/TerminalViewProvider.vaultRename.test.ts — rename routing:
// native SQLite write for opencode/codex vs. sidecar overlay (write-vault-rename-to-store 4_1).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAll, __setAppRoot, __setWorkspaceFolders } from "../test/__mocks__/vscode";

// Keep module import side-effect-free (no native PTY) — the rename path never
// creates a session, but importing the provider pulls these in.
vi.mock("../pty/PtyManager", () => ({
  loadNodePty: vi.fn(() => ({ spawn: vi.fn() })),
  detectShell: vi.fn(() => ({ shell: "/bin/zsh", args: [] })),
  buildEnvironment: vi.fn(() => ({})),
  resolveWorkingDirectory: vi.fn(() => "/tmp"),
}));
vi.mock("../pty/PtySession", () => ({ PtySession: class {} }));
vi.mock("../session/OutputBuffer", () => ({ OutputBuffer: class {} }));

import type * as vscode from "vscode";
import { SessionManager } from "../session/SessionManager";
import type { VaultService } from "../vault/VaultService";
import { TerminalViewProvider } from "./TerminalViewProvider";

beforeEach(() => {
  __resetAll();
  __setAppRoot("/mock/vscode/app");
  __setWorkspaceFolders([{ uri: { fsPath: "/mock/workspace" } }]);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function freshResult(id: string) {
  return {
    entries: [
      { id: `x:${id}`, agent: "x", sessionId: id, title: "t", cwd: "/x", modified: 1, flags: {}, canFork: false },
    ],
    unreadable: { count: 0, reasons: [] },
  };
}

type FakeVault = {
  writeNativeTitle: ReturnType<typeof vi.fn>;
  setCustomName: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  listCached: ReturnType<typeof vi.fn>;
};

function makeFakeVault(over: Partial<FakeVault> = {}): FakeVault {
  return {
    writeNativeTitle: vi.fn(async () => true),
    setCustomName: vi.fn(),
    refresh: vi.fn(async () => freshResult("fresh")),
    listCached: vi.fn(() => null),
    ...over,
  };
}

function mountProvider(vault: FakeVault): {
  send: (msg: unknown) => void;
  postMessageSpy: ReturnType<typeof vi.fn>;
  dispose: () => void;
} {
  const sm = new SessionManager();
  const provider = new TerminalViewProvider(
    { fsPath: "/mock/extension" } as vscode.Uri,
    sm,
    "sidebar",
    null,
    null,
    vault as unknown as VaultService,
  );
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const postMessageSpy = vi.fn(() => Promise.resolve(true));
  const webviewView = {
    visible: true,
    viewType: "anywhereTerminal.sidebar",
    webview: {
      html: "",
      options: {},
      cspSource: "https://mock.csp.source",
      asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
      onDidReceiveMessage: (h: (msg: unknown) => void) => {
        messageHandlers.push(h);
        return { dispose: () => {} };
      },
      postMessage: postMessageSpy,
    },
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  } as unknown as vscode.WebviewView;
  provider.resolveWebviewView(webviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  return {
    send: (msg) => {
      for (const h of messageHandlers) {
        h(msg);
      }
    },
    postMessageSpy,
    dispose: () => sm.dispose(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("handleVaultRenameSession routing", () => {
  it("opencode: native write success clears the overlay and force-refreshes", async () => {
    const vault = makeFakeVault({ writeNativeTitle: vi.fn(async () => true) });
    const { send, postMessageSpy, dispose } = mountProvider(vault);

    send({ type: "vaultRenameSession", entryId: "opencode:o1", name: "New Name" });
    await tick();

    expect(vault.writeNativeTitle).toHaveBeenCalledWith("opencode:o1", "New Name");
    expect(vault.setCustomName).toHaveBeenCalledWith("opencode:o1", ""); // overlay cleared
    expect(vault.refresh).toHaveBeenCalledWith({ force: true });
    const posts = postMessageSpy.mock.calls.filter(([m]) => (m as { type?: string }).type === "vaultSessionsResponse");
    expect(posts).toHaveLength(1);
    expect((posts[0][0] as { fromCache: boolean }).fromCache).toBe(false);
    dispose();
  });

  it("codex: native write failure falls back to the sidecar overlay", async () => {
    const vault = makeFakeVault({
      writeNativeTitle: vi.fn(async () => false),
      listCached: vi.fn(() => freshResult("cached")),
    });
    const { send, postMessageSpy, dispose } = mountProvider(vault);

    send({ type: "vaultRenameSession", entryId: "codex:x1", name: "New Name" });
    await tick();

    expect(vault.writeNativeTitle).toHaveBeenCalledWith("codex:x1", "New Name");
    expect(vault.setCustomName).toHaveBeenCalledWith("codex:x1", "New Name"); // overlay fallback
    expect(vault.refresh).not.toHaveBeenCalled(); // served from listCached
    const posts = postMessageSpy.mock.calls.filter(([m]) => (m as { type?: string }).type === "vaultSessionsResponse");
    expect((posts[0][0] as { fromCache: boolean }).fromCache).toBe(true);
    dispose();
  });

  it("opencode: an empty (clearing) name clears the overlay and never writes the store", async () => {
    const vault = makeFakeVault();
    const { send, dispose } = mountProvider(vault);

    send({ type: "vaultRenameSession", entryId: "opencode:o1", name: "   " });
    await tick();

    expect(vault.writeNativeTitle).not.toHaveBeenCalled();
    expect(vault.setCustomName).toHaveBeenCalledWith("opencode:o1", "");
    dispose();
  });

  it("claude: always uses the sidecar overlay (no native write)", async () => {
    const vault = makeFakeVault();
    const { send, dispose } = mountProvider(vault);

    send({ type: "vaultRenameSession", entryId: "claude:c1", name: "My Session" });
    await tick();

    expect(vault.writeNativeTitle).not.toHaveBeenCalled();
    expect(vault.setCustomName).toHaveBeenCalledWith("claude:c1", "My Session");
    dispose();
  });

  it("caps an over-long name (trim + 80) before the native write", async () => {
    const vault = makeFakeVault({ writeNativeTitle: vi.fn(async () => true) });
    const { send, dispose } = mountProvider(vault);

    send({ type: "vaultRenameSession", entryId: "opencode:o1", name: `  ${"x".repeat(200)}  ` });
    await tick();

    const [, writtenName] = vault.writeNativeTitle.mock.calls[0];
    expect(writtenName).toHaveLength(80);
    dispose();
  });
});
