// src/providers/fileTreeSearchHandler.test.ts — Unit tests for the
// enumeration-style search RPC handler.
//
// Covers:
//   (a) happy path
//   (b) STALE_ROOT at entry (validates before cancelling prior)
//   (c) STALE_ROOT post-findFiles (drop, no post)
//   (d) supersede mid-flight (prior cancelled, prior response not posted)
//   (e) cancellation token disposed in all paths
//   (f) gitignore filter
//   (g) maxResults clamping
//   (h) cancelCurrent() cancels in-flight without posting

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { RequestFileTreeSearchMessage } from "../types/messages";
import { FileTreeSearchHandler, readCombinedExcludeGlob, type SearchVscodeApi } from "./fileTreeSearchHandler";

const SCOPE = "/repo/src";

function makeRequest(overrides: Partial<RequestFileTreeSearchMessage> = {}): RequestFileTreeSearchMessage {
  return {
    type: "request-file-tree-search",
    requestId: "req-1",
    rootGeneration: 0,
    scopePath: SCOPE,
    maxResults: 2000,
    ...overrides,
  };
}

/**
 * Build a SearchVscodeApi backed by a controllable `findFiles` stub. The
 * `findFilesImpl` parameter lets each test override behaviour. Production
 * uses the real `vscode.CancellationTokenSource`; tests spy on its
 * prototype.dispose to verify the lifecycle.
 */
function makeApi(findFilesImpl: SearchVscodeApi["findFiles"]): {
  api: SearchVscodeApi;
  getDisposeSpy: () => ReturnType<typeof vi.spyOn>;
} {
  const disposeSpy = vi.spyOn(vscode.CancellationTokenSource.prototype, "dispose");
  return {
    api: {
      findFiles: findFilesImpl,
      getIgnoredPaths: async () => new Set<string>(),
    },
    getDisposeSpy: () => disposeSpy,
  };
}

describe("readCombinedExcludeGlob", () => {
  it("returns undefined when no enabled patterns exist", async () => {
    const { __setConfigValues } = (await import("vscode")) as unknown as {
      __setConfigValues: (values: Record<string, unknown>) => void;
    };
    __setConfigValues({});
    expect(readCombinedExcludeGlob()).toBeUndefined();
  });

  it("combines files.exclude + search.exclude into a brace glob", async () => {
    const { __setConfigValues } = (await import("vscode")) as unknown as {
      __setConfigValues: (values: Record<string, unknown>) => void;
    };
    __setConfigValues({
      "files.exclude": { "**/.git": true, "**/.DS_Store": true, "**/never-disabled": false },
      "search.exclude": { "**/node_modules": true, "**/dist": true },
    });
    const glob = readCombinedExcludeGlob();
    expect(glob).toContain("**/.git");
    expect(glob).toContain("**/.DS_Store");
    expect(glob).toContain("**/node_modules");
    expect(glob).toContain("**/dist");
    expect(glob).not.toContain("**/never-disabled");
    expect(glob?.startsWith("{")).toBe(true);
    expect(glob?.endsWith("}")).toBe(true);
  });

  it("dedupes identical patterns appearing in both sources", async () => {
    const { __setConfigValues } = (await import("vscode")) as unknown as {
      __setConfigValues: (values: Record<string, unknown>) => void;
    };
    __setConfigValues({
      "files.exclude": { "**/.git": true },
      "search.exclude": { "**/.git": true, "**/node_modules": true },
    });
    const glob = readCombinedExcludeGlob() ?? "";
    const count = (glob.match(/\*\*\/\.git/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("returns bare pattern (no braces) when only one pattern is enabled", async () => {
    const { __setConfigValues } = (await import("vscode")) as unknown as {
      __setConfigValues: (values: Record<string, unknown>) => void;
    };
    __setConfigValues({
      "files.exclude": { "**/.git": true },
    });
    expect(readCombinedExcludeGlob()).toBe("**/.git");
  });
});

describe("FileTreeSearchHandler", () => {
  let provider: { rootGeneration: number };

  beforeEach(() => {
    provider = { rootGeneration: 0 };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) happy path: returns FileTreeSearchResult[] with forward-slash relativePath", async () => {
    const { api, getDisposeSpy } = makeApi(async () => [
      { fsPath: "/repo/src/foo.ts" },
      { fsPath: "/repo/src/nested/bar.ts" },
    ]);
    const handler = new FileTreeSearchHandler(provider, api);
    const res = await handler.handle(makeRequest());

    expect(res?.type).toBe("file-tree-search-response");
    expect(res?.error).toBeUndefined();
    expect(res?.results).toEqual([
      { absolutePath: "/repo/src/foo.ts", relativePath: "foo.ts" },
      { absolutePath: "/repo/src/nested/bar.ts", relativePath: "nested/bar.ts" },
    ]);
    expect(res?.truncated).toBe(false);
    expect(res?.rootGeneration).toBe(0);
    expect(getDisposeSpy()).toHaveBeenCalledTimes(1);
  });

  it("(a.2) truncated: true when findFiles returns exactly maxResults items", async () => {
    const { api } = makeApi(async (_include, _exclude, max) => {
      return Array.from({ length: max }, (_, i) => ({ fsPath: `/repo/src/f${i}.ts` }));
    });
    const handler = new FileTreeSearchHandler(provider, api);
    const res = await handler.handle(makeRequest({ maxResults: 3 }));
    expect(res?.results).toHaveLength(3);
    expect(res?.truncated).toBe(true);
  });

  it("(b) STALE_ROOT validated BEFORE cancelling prior in-flight request", async () => {
    let resolveFirst: (uris: Array<{ fsPath: string }>) => void = () => {};
    const findFilesSpy = vi.fn((_inc, _exc, _max, _token) => {
      return new Promise<Array<{ fsPath: string }>>((res) => {
        resolveFirst = res;
      });
    });
    const { api } = makeApi(findFilesSpy as unknown as SearchVscodeApi["findFiles"]);
    const handler = new FileTreeSearchHandler(provider, api);

    // Kick off a valid request — it's now in flight.
    const valid = handler.handle(makeRequest({ requestId: "valid", rootGeneration: 0 }));
    expect(findFilesSpy).toHaveBeenCalledTimes(1);

    // Stale request arrives — must NOT cancel the valid in-flight one.
    provider.rootGeneration = 5;
    const stale = await handler.handle(makeRequest({ requestId: "stale", rootGeneration: 0 }));
    expect(stale?.error?.code).toBe("STALE_ROOT");

    // Bring provider back so the valid request completes successfully.
    provider.rootGeneration = 0;
    resolveFirst([{ fsPath: "/repo/src/x.ts" }]);
    const validRes = await valid;
    // If the stale request had cancelled the prior token, this would return
    // null (silent drop). Asserting a real response proves order is correct.
    expect(validRes?.results?.[0]?.absolutePath).toBe("/repo/src/x.ts");
  });

  it("(c) STALE_ROOT post-findFiles: response dropped (null) when root bumps during enumeration", async () => {
    let resolveFind: (uris: Array<{ fsPath: string }>) => void = () => {};
    const findFilesPromise = new Promise<Array<{ fsPath: string }>>((res) => {
      resolveFind = res;
    });
    const { api, getDisposeSpy } = makeApi(() => findFilesPromise);
    const handler = new FileTreeSearchHandler(provider, api);

    const inflight = handler.handle(makeRequest({ rootGeneration: 0 }));
    provider.rootGeneration = 1;
    resolveFind([{ fsPath: "/repo/src/x.ts" }]);
    const res = await inflight;
    expect(res).toBeNull();
    expect(getDisposeSpy()).toHaveBeenCalledTimes(1);
  });

  it("(d) supersede mid-flight: prior request's token is cancelled and its response is dropped", async () => {
    const resolvers: Array<(v: Array<{ fsPath: string }>) => void> = [];
    const tokens: vscode.CancellationToken[] = [];
    const { api, getDisposeSpy } = makeApi((_inc, _exc, _max, token) => {
      tokens.push(token);
      return new Promise<Array<{ fsPath: string }>>((res) => resolvers.push(res));
    });
    const handler = new FileTreeSearchHandler(provider, api);

    const first = handler.handle(makeRequest({ requestId: "req-1" }));
    const second = handler.handle(makeRequest({ requestId: "req-2" }));

    expect(tokens[0].isCancellationRequested).toBe(true);
    expect(tokens[1].isCancellationRequested).toBe(false);

    resolvers[0]([{ fsPath: "/repo/src/a.ts" }]);
    resolvers[1]([{ fsPath: "/repo/src/b.ts" }]);

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBeNull();
    expect(r2?.results?.[0]?.relativePath).toBe("b.ts");
    expect(getDisposeSpy()).toHaveBeenCalledTimes(2);
  });

  it("(e) token disposed in finally on findFiles error path", async () => {
    const { api, getDisposeSpy } = makeApi(async () => {
      throw new Error("boom");
    });
    const handler = new FileTreeSearchHandler(provider, api);
    const res = await handler.handle(makeRequest());
    expect(res?.error?.code).toBe("INTERNAL");
    expect(res?.error?.message).toContain("boom");
    expect(getDisposeSpy()).toHaveBeenCalledTimes(1);
  });

  it("(f) drops gitignored paths from the response", async () => {
    const { api } = makeApi(async () => [
      { fsPath: "/repo/src/foo.ts" },
      { fsPath: "/repo/dist/built.js" },
      { fsPath: "/repo/secret.env" },
    ]);
    api.getIgnoredPaths = async () => new Set<string>(["/repo/dist/built.js", "/repo/secret.env"]);
    const handler = new FileTreeSearchHandler(provider, api);
    const res = await handler.handle(makeRequest());
    expect(res?.results?.map((r) => r.relativePath)).toEqual(["foo.ts"]);
  });

  it("(f.2) truncation reflects the underlying enumeration cap, not the post-filter count", async () => {
    const { api } = makeApi(async (_inc, _exc, max) =>
      Array.from({ length: max }, (_, i) => ({ fsPath: `/repo/dist/${i}.js` })),
    );
    api.getIgnoredPaths = async (_scope, paths) => new Set<string>(paths);
    const handler = new FileTreeSearchHandler(provider, api);
    const res = await handler.handle(makeRequest({ maxResults: 5 }));
    expect(res?.results).toHaveLength(0);
    expect(res?.truncated).toBe(true);
  });

  it("(f.3) survives gitignore failure silently (empty set means no filtering)", async () => {
    const { api } = makeApi(async () => [{ fsPath: "/repo/foo.ts" }]);
    api.getIgnoredPaths = async () => new Set<string>();
    const handler = new FileTreeSearchHandler(provider, api);
    const res = await handler.handle(makeRequest());
    expect(res?.results).toHaveLength(1);
  });

  it("(g) maxResults: clamps non-finite/out-of-range to defaults", async () => {
    const calls: number[] = [];
    const { api } = makeApi(async (_inc, _exc, max) => {
      calls.push(max);
      return [];
    });
    const handler = new FileTreeSearchHandler(provider, api);
    await handler.handle(makeRequest({ maxResults: undefined }));
    await handler.handle(makeRequest({ maxResults: 0 }));
    await handler.handle(makeRequest({ maxResults: 99999 }));
    await handler.handle(makeRequest({ maxResults: Number.NaN }));
    expect(calls).toEqual([2000, 1, 5000, 2000]);
  });

  it("(h) cancelCurrent() cancels in-flight request without posting", async () => {
    let resolveFind: (uris: Array<{ fsPath: string }>) => void = () => {};
    const tokens: vscode.CancellationToken[] = [];
    const { api, getDisposeSpy } = makeApi((_inc, _exc, _max, token) => {
      tokens.push(token);
      return new Promise<Array<{ fsPath: string }>>((res) => {
        resolveFind = res;
      });
    });
    const handler = new FileTreeSearchHandler(provider, api);
    const inflight = handler.handle(makeRequest());
    handler.cancelCurrent();
    expect(tokens[0].isCancellationRequested).toBe(true);
    resolveFind([{ fsPath: "/repo/src/x.ts" }]);
    const res = await inflight;
    expect(res).toBeNull();
    expect(getDisposeSpy()).toHaveBeenCalledTimes(1);
  });

  it("(h.2) dispose() is an alias for cancelCurrent()", async () => {
    let resolveFind: (uris: Array<{ fsPath: string }>) => void = () => {};
    const tokens: vscode.CancellationToken[] = [];
    const { api } = makeApi((_inc, _exc, _max, token) => {
      tokens.push(token);
      return new Promise<Array<{ fsPath: string }>>((res) => {
        resolveFind = res;
      });
    });
    const handler = new FileTreeSearchHandler(provider, api);
    const inflight = handler.handle(makeRequest());
    handler.dispose();
    expect(tokens[0].isCancellationRequested).toBe(true);
    resolveFind([]);
    const res = await inflight;
    expect(res).toBeNull();
  });
});
