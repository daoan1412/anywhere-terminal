// src/providers/pathPreprocess.ts — Normalize a clicked path before the
// resolver fans candidates. Handles tilde expansion (`~` / `~/foo`) and
// `file://` URI decoding via `vscode.Uri.parse` with scheme/query/fragment
// guards. Malformed `file://` falls through as `passthrough-malformed` so the
// resolver short-circuits to "File not found" without ever stat'ing garbage.
//
// See: asimov/specs/terminal-clickable-file-paths/spec.md
// See: asimov/changes/fix-open-file-path-resolution/design.md D4, D5

import * as os from "node:os";
import * as vscode from "vscode";

export type PathKind = "absolute-file-uri" | "tilde-expanded" | "passthrough" | "passthrough-malformed";

export function expandTildeAndFileUri(raw: string, homedir?: string): { path: string; kind: PathKind } {
  if (raw.startsWith("file://")) {
    try {
      const uri = vscode.Uri.parse(raw, true);
      // Strict guards. Each excludes a specific abuse:
      // - scheme==="file": `vscode.Uri.parse` will accept anything starting
      //   with `file:` (e.g. `file:foo`); pin to canonical `file://`.
      // - authority==="": defends against Windows UNC injection via
      //   `file://<attacker-host>/share/x.md` → `\\<host>\share\x.md`, which
      //   `fs.stat` would resolve over SMB BEFORE the out-of-scope modal
      //   fires, leaking the click as network egress (+ NTLM credentials).
      // - query/fragment empty: `?`/`#` in a clicked path would otherwise
      //   silently become URL query/fragment, mangling the resolved path.
      // - fsPath truthy AND no NUL byte: defense-in-depth against
      //   `%00`-terminated paths whose log diagnostic would mismatch what
      //   `fs.stat` actually opens.
      if (
        uri.scheme === "file" &&
        uri.authority === "" &&
        uri.query === "" &&
        uri.fragment === "" &&
        uri.fsPath &&
        !uri.fsPath.includes("\x00")
      ) {
        return { path: uri.fsPath, kind: "absolute-file-uri" };
      }
    } catch {
      // fall through to passthrough-malformed
    }
    return { path: raw, kind: "passthrough-malformed" };
  }
  if (raw === "~") {
    return { path: homedir ?? os.homedir(), kind: "tilde-expanded" };
  }
  if (raw.startsWith("~/")) {
    return { path: `${homedir ?? os.homedir()}${raw.slice(1)}`, kind: "tilde-expanded" };
  }
  return { path: raw, kind: "passthrough" };
}
