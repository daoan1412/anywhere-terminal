// src/test/fileTreeRpc.integration.test.ts — Integration test for the
// file-tree RPC handler (`request-read-directory` round-trip).
//
// Verifies the three Acceptance branches from task 3_2:
//   1. valid generation + in-workspace path  → entries populated, echo
//                                               current rootGeneration, no error.
//   2. stale generation                       → error.code = "STALE_ROOT".
//   3. out-of-workspace path                  → error.code = "OUT_OF_WORKSPACE".
//
// Uses a real temp directory (node:fs + node:os) so `vscode.workspace.fs`
// can be a thin pass-through to node's fs. The handler accepts injected
// `fs` and `Uri` so we don't need to extend the global vscode mock.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRequestReadDirectory, type RootProvider } from "../providers/fileTreeRpcHandler";
import type { ReadDirectoryResponseMessage, RequestReadDirectoryMessage } from "../types/messages";

// ─── Test fs/Uri shims ──────────────────────────────────────────────
//
// The handler's `fs` parameter is typed as `typeof vscode.workspace.fs`. The
// only method it calls is `readDirectory(uri): Promise<[string, FileType][]>`.
// We cast through `unknown` to a structural match — that lets the test
// dodge the full vscode.FileSystem surface (writeFile, copy, ...) we don't use.

const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;

interface MinimalUri {
  fsPath: string;
}

interface MinimalFs {
  readDirectory(uri: MinimalUri): Promise<Array<[string, number]>>;
}

const minimalFs: MinimalFs = {
  async readDirectory(uri) {
    const dirents = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return dirents.map((d): [string, number] => {
      if (d.isDirectory()) {
        return [d.name, FILE_TYPE_DIRECTORY];
      }
      if (d.isFile()) {
        return [d.name, FILE_TYPE_FILE];
      }
      return [d.name, 0];
    });
  },
};

const minimalUri = {
  file: (p: string): MinimalUri => ({ fsPath: p }),
};

// Cast helpers — the handler's signature pins these to the real vscode types
// but only uses the structural subset above.
// biome-ignore lint/suspicious/noExplicitAny: structural-only test shim
const fsArg = minimalFs as any;
// biome-ignore lint/suspicious/noExplicitAny: structural-only test shim
const uriArg = minimalUri as any;

// ─── Temp workspace fixture ─────────────────────────────────────────

let tempDir: string;
let outsideDir: string;

beforeAll(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "file-tree-rpc-"));
  outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "file-tree-rpc-outside-"));
  // Populate: two files and a subdirectory.
  await fs.promises.writeFile(path.join(tempDir, "a.txt"), "alpha", "utf8");
  await fs.promises.writeFile(path.join(tempDir, "b.txt"), "beta", "utf8");
  await fs.promises.mkdir(path.join(tempDir, "sub"));
});

afterAll(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  await fs.promises.rm(outsideDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

function makeProvider(rootGeneration: number, workspaceRoot: string | null): RootProvider {
  return { rootGeneration, workspaceRoot };
}

async function runRpc(msg: RequestReadDirectoryMessage, provider: RootProvider): Promise<ReadDirectoryResponseMessage> {
  const responses: ReadDirectoryResponseMessage[] = [];
  await handleRequestReadDirectory(msg, provider, (r) => responses.push(r), fsArg, uriArg);
  expect(responses).toHaveLength(1);
  return responses[0];
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("fileTreeRpcHandler integration", () => {
  it("Scenario 1: valid generation + in-workspace path → entries populated, generation echoed", async () => {
    const provider = makeProvider(7, tempDir);
    const response = await runRpc(
      {
        type: "request-read-directory",
        requestId: "req-1",
        rootGeneration: 7,
        path: tempDir,
      },
      provider,
    );

    expect(response.requestId).toBe("req-1");
    expect(response.rootGeneration).toBe(7);
    expect(response.error).toBeUndefined();
    expect(response.entries).toBeDefined();

    const entries = response.entries ?? [];
    // 2 files + 1 directory.
    expect(entries).toHaveLength(3);

    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("a.txt")?.kind).toBe("file");
    expect(byName.get("a.txt")?.path).toBe(path.join(tempDir, "a.txt"));
    expect(byName.get("b.txt")?.kind).toBe("file");
    expect(byName.get("sub")?.kind).toBe("directory");
    expect(byName.get("sub")?.path).toBe(path.join(tempDir, "sub"));
  });

  it("Scenario 2: stale generation → error.code = STALE_ROOT, current generation echoed", async () => {
    const provider = makeProvider(7, tempDir);
    const response = await runRpc(
      {
        type: "request-read-directory",
        requestId: "req-stale",
        rootGeneration: 6,
        path: tempDir,
      },
      provider,
    );

    expect(response.requestId).toBe("req-stale");
    expect(response.rootGeneration).toBe(7);
    expect(response.entries).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe("STALE_ROOT");
  });

  it("Scenario 3: path outside workspace is ALLOWED — handler reads any absolute path", async () => {
    // OUT_OF_WORKSPACE used to be a hard reject. We dropped it so the file
    // tree can re-root to whatever folder the shell `cd`'d into (terminal
    // workflow). The OS remains the security boundary.
    const provider = makeProvider(7, tempDir);
    const response = await runRpc(
      {
        type: "request-read-directory",
        requestId: "req-oob",
        rootGeneration: 7,
        path: outsideDir,
      },
      provider,
    );

    expect(response.requestId).toBe("req-oob");
    expect(response.rootGeneration).toBe(7);
    expect(response.error).toBeUndefined();
    expect(response.entries).toBeDefined();
  });

  it("workspaceRoot=null still allows reads — only STALE_ROOT and FS_ERROR remain as failure modes", async () => {
    const provider = makeProvider(7, null);
    const response = await runRpc(
      {
        type: "request-read-directory",
        requestId: "req-no-ws",
        rootGeneration: 7,
        path: tempDir,
      },
      provider,
    );

    expect(response.error).toBeUndefined();
    expect(response.entries).toBeDefined();
  });
});
