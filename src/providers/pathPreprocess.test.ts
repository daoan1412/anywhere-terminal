// src/providers/pathPreprocess.test.ts — full coverage for tilde + file://
// pre-processing. Mock `vscode.Uri.parse` lives in src/test/__mocks__/vscode.ts.

import { describe, expect, it } from "vitest";
import { expandTildeAndFileUri } from "./pathPreprocess";

const HOME = "/home/test";

describe("expandTildeAndFileUri — tilde expansion", () => {
  it("expands ~/foo with injected homedir", () => {
    expect(expandTildeAndFileUri("~/foo/bar.md", HOME)).toEqual({
      path: "/home/test/foo/bar.md",
      kind: "tilde-expanded",
    });
  });

  it("expands bare ~ to homedir", () => {
    expect(expandTildeAndFileUri("~", HOME)).toEqual({ path: HOME, kind: "tilde-expanded" });
  });

  it("leaves ~user untouched (passthrough)", () => {
    expect(expandTildeAndFileUri("~bob/foo.md", HOME)).toEqual({
      path: "~bob/foo.md",
      kind: "passthrough",
    });
  });
});

describe("expandTildeAndFileUri — file:// URI", () => {
  it("parses well-formed file:///abs/file.md", () => {
    expect(expandTildeAndFileUri("file:///abs/file.md", HOME)).toEqual({
      path: "/abs/file.md",
      kind: "absolute-file-uri",
    });
  });

  it("percent-decodes file:///abs/foo%20bar.md", () => {
    expect(expandTildeAndFileUri("file:///abs/foo%20bar.md", HOME)).toEqual({
      path: "/abs/foo bar.md",
      kind: "absolute-file-uri",
    });
  });

  it("malformed file://garbage (no path) → passthrough-malformed", () => {
    // After `file://garbage`, authority=garbage, path is empty → fsPath empty
    // → fails the non-empty fsPath guard → passthrough-malformed.
    const out = expandTildeAndFileUri("file://garbage", HOME);
    expect(out.kind).toBe("passthrough-malformed");
  });

  it("non-empty query rejects: file:///abs/file.md?x=1 → passthrough-malformed", () => {
    expect(expandTildeAndFileUri("file:///abs/file.md?x=1", HOME)).toEqual({
      path: "file:///abs/file.md?x=1",
      kind: "passthrough-malformed",
    });
  });

  it("non-empty fragment rejects: file:///abs/file.md#frag → passthrough-malformed", () => {
    expect(expandTildeAndFileUri("file:///abs/file.md#frag", HOME)).toEqual({
      path: "file:///abs/file.md#frag",
      kind: "passthrough-malformed",
    });
  });

  it("non-empty authority rejects: file://attacker.example.com/share/x.md (UNC defense)", () => {
    // On Windows, `vscode.Uri.parse('file://attacker.example.com/share/x.md').fsPath`
    // becomes `\\attacker.example.com\share\x.md`, which `fs.stat` would resolve
    // over SMB before any out-of-scope modal fires — leaking network egress +
    // potentially NTLM credentials. Reject anything with an authority component.
    expect(expandTildeAndFileUri("file://attacker.example.com/share/x.md", HOME)).toEqual({
      path: "file://attacker.example.com/share/x.md",
      kind: "passthrough-malformed",
    });
  });

  it("NUL byte in decoded fsPath rejects: file:///abs/x%00.md → passthrough-malformed", () => {
    // Defense in depth: prevents log-vs-stat path mismatches if an OS layer
    // ever truncates at NUL while we log the full decoded path.
    expect(expandTildeAndFileUri("file:///abs/x%00.md", HOME)).toEqual({
      path: "file:///abs/x%00.md",
      kind: "passthrough-malformed",
    });
  });
});

describe("expandTildeAndFileUri — passthrough", () => {
  it("plain absolute path", () => {
    expect(expandTildeAndFileUri("/abs/file.md", HOME)).toEqual({
      path: "/abs/file.md",
      kind: "passthrough",
    });
  });

  it("plain relative path", () => {
    expect(expandTildeAndFileUri("foo/bar.md", HOME)).toEqual({
      path: "foo/bar.md",
      kind: "passthrough",
    });
  });

  it("default homedir falls back to os.homedir() when not injected", () => {
    // Just assert the kind so we don't depend on the runner's $HOME.
    const out = expandTildeAndFileUri("~/foo.md");
    expect(out.kind).toBe("tilde-expanded");
    expect(out.path.endsWith("/foo.md")).toBe(true);
  });
});
