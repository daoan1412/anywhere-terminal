// src/providers/previewFileLink.test.ts — Resolver paths + status shaping
// + cancellation. See: design.md D5 + spec "first-hit path resolution for hover".

import { describe, expect, it, vi } from "vitest";
import type { FilePreviewResultMessage, RequestFilePreviewMessage } from "../types/messages";
import { languageIdFromUri, type PreviewFileLinkDeps, previewFileLink } from "./previewFileLink";

// Simulate vscode.FileType.Directory = 2 (bit mask).
const DIRECTORY = 2;
const FILE = 1;

function fakeUri(p: string): { fsPath: string; path: string } {
  return { fsPath: p, path: p };
}

function makeFakeToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function makeFakeTokenSource() {
  return {
    token: makeFakeToken(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeDeps(overrides: Partial<PreviewFileLinkDeps> = {}): PreviewFileLinkDeps {
  return {
    getInitialCwd: () => undefined,
    getCurrentCwd: () => undefined,
    workspaceFolders: undefined,
    fs: {
      stat: vi.fn(async () => {
        throw new Error("file not found");
      }),
      readFile: vi.fn(async () => new Uint8Array()),
    },
    findFiles: vi.fn(async () => []),
    uriFactory: { file: (p: string) => fakeUri(p) as never },
    createCancellationTokenSource: () => makeFakeTokenSource() as never,
    directoryFileType: DIRECTORY,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RequestFilePreviewMessage> = {}): RequestFilePreviewMessage {
  return {
    type: "requestFilePreview",
    requestId: "req-1",
    sessionId: "sess-1",
    path: "src/foo.ts",
    ...overrides,
  };
}

async function runWith(deps: PreviewFileLinkDeps, msg = makeRequest()): Promise<FilePreviewResultMessage | null> {
  return previewFileLink(msg, deps, makeFakeToken() as never);
}

describe("languageIdFromUri", () => {
  it("maps known extensions to language ids", () => {
    expect(languageIdFromUri(fakeUri("/x/foo.ts") as never)).toBe("typescript");
    expect(languageIdFromUri(fakeUri("/x/foo.tsx") as never)).toBe("tsx");
    expect(languageIdFromUri(fakeUri("/x/foo.md") as never)).toBe("markdown");
    expect(languageIdFromUri(fakeUri("/x/foo.MarkDown") as never)).toBe("markdown");
    expect(languageIdFromUri(fakeUri("/x/foo.cpp") as never)).toBe("cpp");
    expect(languageIdFromUri(fakeUri("/x/foo.cc") as never)).toBe("cpp");
    expect(languageIdFromUri(fakeUri("/x/foo.unknownext") as never)).toBe("plaintext");
  });
  it("returns plaintext for a path with no extension", () => {
    expect(languageIdFromUri(fakeUri("/x/Makefile") as never)).toBe("plaintext");
  });
});

describe("previewFileLink — resolution", () => {
  it("returns not-found when path is empty", async () => {
    const result = await runWith(makeDeps(), makeRequest({ path: "" }));
    expect(result?.status).toBe("not-found");
  });

  it("returns not-found when path ends with a separator (directory)", async () => {
    const result = await runWith(makeDeps(), makeRequest({ path: "src/foo/" }));
    expect(result?.status).toBe("not-found");
  });

  it("returns ok when the first candidate stat hits a file", async () => {
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: 4 })),
      readFile: vi.fn(async () => new TextEncoder().encode("text")),
    };
    const deps = makeDeps({
      fs,
      getInitialCwd: () => "/ws",
    });
    const result = await runWith(deps);
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.absPath).toBe("/ws/src/foo.ts");
    expect(result.languageId).toBe("typescript");
    expect(result.isMarkdown).toBe(false);
    expect(result.content).toBe("text");
  });

  it("falls through directory hits and emits not-found when no file is found", async () => {
    const fs = {
      stat: vi.fn(async () => ({ type: DIRECTORY, ctime: 0, mtime: 0, size: 0 })),
      readFile: vi.fn(async () => new Uint8Array()),
    };
    const result = await runWith(makeDeps({ fs, getInitialCwd: () => "/ws" }));
    expect(result?.status).toBe("not-found");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("returns ambiguous when findFiles returns ≥2 matches and no candidate hit earlier", async () => {
    const findFiles = vi.fn(async () => [fakeUri("/ws/a/foo.ts") as never, fakeUri("/ws/b/foo.ts") as never]);
    const deps = makeDeps({
      findFiles: findFiles as never,
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "foo.ts" }));
    expect(result?.status).toBe("ambiguous");
  });

  it("returns ok for a single findFiles match when candidates miss", async () => {
    const findFiles = vi.fn(async () => [fakeUri("/ws/dir/foo.ts") as never]);
    const fs = {
      stat: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
      readFile: vi.fn(async () => new TextEncoder().encode("ok")),
    };
    const deps = makeDeps({
      fs,
      findFiles: findFiles as never,
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    // First call (stat in candidate loop) fails; findFiles wins.
    fs.stat = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce({ type: FILE, ctime: 0, mtime: 0, size: 2 });
    const result = await runWith(deps, makeRequest({ path: "foo.ts" }));
    // findFiles returned a Uri; the post-resolve readFileForPreview is then called.
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.absPath).toBe("/ws/dir/foo.ts");
  });

  it("never shows a quickPick — ambiguity is a status, not a UI", async () => {
    // No quickPick is part of deps — verifying via absence + structure.
    const findFiles = vi.fn(async () => [fakeUri("/a/foo.ts") as never, fakeUri("/b/foo.ts") as never]);
    const deps = makeDeps({
      findFiles: findFiles as never,
      workspaceFolders: [{ uri: { fsPath: "/" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "foo.ts" }));
    expect(result?.status).toBe("ambiguous");
    // The deps interface deliberately has no showQuickPick — compile-time check.
    expect((deps as { showQuickPick?: unknown }).showQuickPick).toBeUndefined();
  });

  it("never shows a modal — out-of-workspace paths return requires-confirmation (no UI block)", async () => {
    // Round-1 B1 + round-2 W3: when the hover resolves to a path that's not
    // under any trust base (here `/etc/hosts` with no workspace + no
    // initialCwd → empty trust bases → fail-closed out-of-workspace), the
    // resolver returns `requires-confirmation` rather than reading the file
    // silently. There is still no MODAL — the popup shows a placeholder and
    // the user can press Cmd/Ctrl to override. This test asserts both halves.
    const buf = new TextEncoder().encode("etc/hosts content");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({ fs });
    const result = await runWith(deps, makeRequest({ path: "/etc/hosts" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("out-of-workspace");
    expect(result.absPath).toBe("/etc/hosts");
    // No showWarning in deps interface — modal cannot be triggered.
    expect((deps as { showWarning?: unknown }).showWarning).toBeUndefined();
    // Content MUST NOT have been read.
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("marks .md files as isMarkdown=true", async () => {
    const buf = new TextEncoder().encode("# hi");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({ fs, getInitialCwd: () => "/ws" });
    const result = await runWith(deps, makeRequest({ path: "README.md" }));
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.isMarkdown).toBe(true);
    expect(result.languageId).toBe("markdown");
  });

  it("propagates too-large status when stat.size exceeds the hard limit", async () => {
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: 5_000_000 })),
      readFile: vi.fn(async () => new Uint8Array()),
    };
    const deps = makeDeps({ fs, getInitialCwd: () => "/ws" });
    const result = await runWith(deps);
    expect(result?.status).toBe("too-large");
    if (result?.status !== "too-large") {
      throw new Error("expected too-large");
    }
    expect(result.totalBytes).toBe(5_000_000);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("falls back to basename search when the first findFiles returns 0 + path has a separator", async () => {
    const buf = new TextEncoder().encode("hello");
    // First call (full path) → 0 matches; second call (basename) → 1 match.
    const findFiles = vi
      .fn()
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([fakeUri("/ws/deeper/src/foo.ts") as never]);
    const fs = {
      // First stat in candidate loop misses; after findFiles we read the URI.
      stat: vi
        .fn()
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength }),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({
      fs,
      findFiles: findFiles as never,
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "src/foo.ts" }));
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.absPath).toBe("/ws/deeper/src/foo.ts");
    // Two findFiles invocations: first the full-path glob, then the basename glob.
    expect(findFiles).toHaveBeenCalledTimes(2);
    const firstGlob = findFiles.mock.calls[0][0];
    const secondGlob = findFiles.mock.calls[1][0];
    expect(firstGlob).toBe("**/src/foo.ts");
    expect(secondGlob).toBe("**/foo.ts");
  });

  it("skips basename fallback when the path has NO separator (single basename already)", async () => {
    const findFiles = vi.fn().mockResolvedValueOnce([]);
    const deps = makeDeps({
      findFiles: findFiles as never,
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "foo.ts" }));
    expect(result?.status).toBe("not-found");
    expect(findFiles).toHaveBeenCalledTimes(1);
  });

  it("anchors no-workspace search via relativePatternFactory at liveCwd / initialCwd", async () => {
    const buf = new TextEncoder().encode("hi");
    const findFiles = vi.fn().mockResolvedValueOnce([fakeUri("/cwd/dir/foo.ts") as never]);
    const relativePatternFactory = vi.fn((base, glob) => ({ base, glob, __relative: true }));
    const fs = {
      // Candidate loop will miss (no workspace + no cwd-based candidates produced).
      stat: vi
        .fn()
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength }),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({
      fs,
      findFiles: findFiles as never,
      relativePatternFactory: relativePatternFactory as never,
      workspaceFolders: undefined,
      getInitialCwd: () => "/cwd", // anchor trust base so the result isn't out-of-workspace
      getLiveCwd: async () => "/cwd",
    });
    const result = await runWith(deps, makeRequest({ path: "dir/foo.ts" }));
    expect(result?.status).toBe("ok");
    expect(relativePatternFactory).toHaveBeenCalled();
    const [baseArg, globArg] = relativePatternFactory.mock.calls[0];
    expect(baseArg).toEqual(expect.objectContaining({ fsPath: "/cwd" }));
    expect(globArg).toBe("**/dir/foo.ts");
  });

  it("returns not-found when no workspace AND no cwd source AND no relativePatternFactory", async () => {
    const findFiles = vi.fn().mockResolvedValueOnce([]);
    const deps = makeDeps({
      findFiles: findFiles as never,
      workspaceFolders: undefined,
      relativePatternFactory: undefined,
    });
    const result = await runWith(deps, makeRequest({ path: "foo.ts" }));
    expect(result?.status).toBe("not-found");
    // findFiles never runs because we couldn't build a search pattern.
    expect(findFiles).not.toHaveBeenCalled();
  });

  it("returns null (drop result) when the token cancels mid-flow", async () => {
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const fs = {
      stat: vi.fn(async () => {
        // Trip the token between stat and the post-resolution branch.
        token.isCancellationRequested = true;
        return { type: FILE, ctime: 0, mtime: 0, size: 4 };
      }),
      readFile: vi.fn(async () => new TextEncoder().encode("text")),
    };
    const deps = makeDeps({ fs, getInitialCwd: () => "/ws" });
    const result = await previewFileLink(makeRequest(), deps, token as never);
    expect(result).toBeNull();
  });
});

describe("trust policy (B1)", () => {
  it("blocks dotfile (basename starts with `.`) — returns requires-confirmation", async () => {
    const buf = new TextEncoder().encode("ENV_VAR=secret");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({ fs, getInitialCwd: () => "/ws" });
    const result = await runWith(deps, makeRequest({ path: "/ws/.env" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("dotfile");
    expect(result.absPath).toBe("/ws/.env");
    // Content MUST NOT have been read.
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("blocks file inside a dot-folder — returns sensitive-dir", async () => {
    const buf = new TextEncoder().encode("ssh key");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({ fs, getInitialCwd: () => "/home/u" });
    const result = await runWith(deps, makeRequest({ path: "/home/u/.ssh/id_rsa" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("sensitive-dir");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("blocks file inside node_modules — returns sensitive-dir", async () => {
    const buf = new TextEncoder().encode("lib code");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({
      fs,
      getInitialCwd: () => "/ws",
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "/ws/node_modules/lodash/index.js" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("sensitive-dir");
  });

  it("blocks newly-added sensitive folders (.terraform / .npm / .gem / .azure) — round-2 W7", async () => {
    const buf = new TextEncoder().encode("token");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const cases = [
      "/home/u/.terraform.d/credentials.tfrc.json", // Terraform Cloud token
      "/home/u/.gem/credentials", // RubyGems API key
      "/home/u/.npm/_logs/2026-debug.log", // npm error log (may contain auth headers)
      "/home/u/.azure/accessTokens.json", // Azure CLI tokens
      "/home/u/.helm/repository/repositories.yaml", // Helm repo credentials
    ];
    for (const target of cases) {
      const deps = makeDeps({ fs, getInitialCwd: () => "/home/u", workspaceFolders: [{ uri: { fsPath: "/home/u" } }] });
      const result = await runWith(deps, makeRequest({ path: target }));
      if (result?.status !== "requires-confirmation") {
        throw new Error(`expected requires-confirmation for ${target}, got ${result?.status}`);
      }
      expect(result.reason).toBe("sensitive-dir");
    }
  });

  it("does NOT block common non-sensitive dot-folders like .vscode / .next / .reviews", async () => {
    // The original trust policy treated EVERY dot-prefix segment as sensitive,
    // which surprised users with paths inside `.vscode/`, `.next/`, `.reviews/`
    // (this project's review folder) etc. Round-2 narrowed the rule to a
    // specific allowlist; anything not in it must auto-preview.
    const buf = new TextEncoder().encode("normal file");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const cases = [
      "/ws/.vscode/settings.json",
      "/ws/.next/cache/foo.txt",
      "/ws/.reviews/round-1.md",
      "/ws/.claude/settings.json",
      "/ws/.idea/workspace.xml",
    ];
    for (const target of cases) {
      const deps = makeDeps({ fs, getInitialCwd: () => "/ws", workspaceFolders: [{ uri: { fsPath: "/ws" } }] });
      const result = await runWith(deps, makeRequest({ path: target }));
      if (result?.status !== "ok") {
        throw new Error(`expected ok status for ${target}, got ${result?.status}`);
      }
    }
  });

  it("blocks files outside workspace + initialCwd — returns out-of-workspace", async () => {
    const buf = new TextEncoder().encode("etc content");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({
      fs,
      getInitialCwd: () => "/home/u/proj",
      workspaceFolders: [{ uri: { fsPath: "/home/u/proj" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "/etc/hosts" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("out-of-workspace");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("fails CLOSED when there are no trust bases (round-2 W3)", async () => {
    // No workspace folders, no initialCwd → trustBases.length === 0. Pre-W3
    // the resolver returned `ok` and read the file silently. Post-W3, classify
    // returns `out-of-workspace` and the popup requires the override gesture.
    const buf = new TextEncoder().encode("anything");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({ fs }); // makeDeps defaults: undefined initialCwd + undefined workspaceFolders
    const result = await runWith(deps, makeRequest({ path: "/home/u/anyfile.txt" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("out-of-workspace");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("symlink target inside trust base STILL requires confirmation (round-2 W4)", async () => {
    // A symlink at /ws/link.ts may point to ~/.ssh/id_rsa. classifyTrust on
    // the lexical /ws/link.ts says "in workspace, allow", but the read
    // dereferences the symlink target. With symbolicLinkFileType wired, the
    // resolver flags the symlink and previewFileLink forces requires-
    // confirmation regardless of lexical classification.
    const SYMLINK = 64; // matches vscode.FileType.SymbolicLink
    const buf = new TextEncoder().encode("placeholder");
    const fs = {
      // type bitfield: File (1) | SymbolicLink (64) = 65
      stat: vi.fn(async () => ({ type: 1 | SYMLINK, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({
      fs,
      getInitialCwd: () => "/ws",
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
      directoryFileType: 2,
      symbolicLinkFileType: SYMLINK,
    });
    const result = await runWith(deps, makeRequest({ path: "/ws/link.ts" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("out-of-workspace");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("does NOT block when path is INSIDE a workspace folder", async () => {
    const buf = new TextEncoder().encode("const x = 1");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({
      fs,
      getInitialCwd: () => "/ws",
      workspaceFolders: [{ uri: { fsPath: "/ws" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "/ws/src/foo.ts" }));
    expect(result?.status).toBe("ok");
  });

  it("override=true bypasses the trust check and returns ok", async () => {
    const buf = new TextEncoder().encode("ENV_VAR=secret");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    const deps = makeDeps({ fs, getInitialCwd: () => "/ws" });
    const result = await runWith(deps, makeRequest({ path: "/ws/.env", override: true }));
    expect(result?.status).toBe("ok");
    if (result?.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.content).toBe("ENV_VAR=secret");
    expect(fs.readFile).toHaveBeenCalled();
  });

  it("currentCwd is NOT included in trust bases — shell-emitted OSC 7 cannot grant trust", async () => {
    const buf = new TextEncoder().encode("attacker target");
    const fs = {
      stat: vi.fn(async () => ({ type: FILE, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    };
    // currentCwd is "/" (shell-injected via OSC 7), but it MUST NOT be in trust bases.
    const deps = makeDeps({
      fs,
      getInitialCwd: () => "/home/u/proj",
      getCurrentCwd: () => "/",
      workspaceFolders: [{ uri: { fsPath: "/home/u/proj" } }],
    });
    const result = await runWith(deps, makeRequest({ path: "/etc/passwd" }));
    expect(result?.status).toBe("requires-confirmation");
    if (result?.status !== "requires-confirmation") {
      throw new Error("expected requires-confirmation");
    }
    expect(result.reason).toBe("out-of-workspace");
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
