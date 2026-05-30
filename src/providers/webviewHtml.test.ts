import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { getTerminalHtml } from "./webviewHtml";

function mockWebview(): vscode.Webview {
  return {
    cspSource: "https://mock.csp.source",
    // Matches the real signature shape used elsewhere in provider tests: returns
    // the fsPath string (NOT a Uri), so the cache-buster must compose in string space.
    asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
  } as unknown as vscode.Webview;
}

describe("getTerminalHtml webview.js cache-buster (D11)", () => {
  it("appends a ?v= version query to the webview.js script src", () => {
    const html = getTerminalHtml(mockWebview(), vscode.Uri.file("/ext"), "sidebar");
    const match = html.match(/src="([^"]*webview\.js[^"]*)"/);
    expect(match).not.toBeNull();
    // A reload must never serve a stale bundle: the script URL carries a version query.
    expect(match?.[1]).toMatch(/webview\.js\?v=.+/);
    // Exactly one query separator (no double "?").
    expect((match?.[1].match(/\?/g) ?? []).length).toBe(1);
  });

  it("keeps the vault panel CSS INLINE (the externalization was reverted — D15)", () => {
    const html = getTerminalHtml(mockWebview(), vscode.Uri.file("/ext"), "sidebar");
    // The vault CSS is inlined into the host <style> (regenerated per render, so it
    // can never be served stale); it is NOT an external cache-busted <link>.
    expect(html).not.toMatch(/<link[^>]*vaultPanel\.css/);
  });
});
