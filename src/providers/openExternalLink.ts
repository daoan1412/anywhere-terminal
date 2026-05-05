import * as vscode from "vscode";

/**
 * Confirm with the user before opening an http(s) URL externally.
 *
 * VS Code's built-in trusted-domains prompt only appears when the user has
 * that feature enabled and hasn't already trusted the host. To give a
 * predictable Cmd+Click experience inside the AnyWhere Terminal webview, we
 * always show our own confirmation with Open / Copy / Cancel.
 */
export async function openExternalLink(url: string): Promise<void> {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Do you want to open the following URL?\n\n${url}`,
    { modal: true },
    "Open",
    "Copy",
  );
  if (choice === "Open") {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  } else if (choice === "Copy") {
    await vscode.env.clipboard.writeText(url);
  }
}
