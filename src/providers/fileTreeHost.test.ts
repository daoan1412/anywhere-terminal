// src/providers/fileTreeHost.test.ts — Pinpoint regression tests for the
// FileTreeHost message dispatch.
//
// The host owns the central dispatch for file-tree messages; both
// TerminalViewProvider and TerminalEditorProvider forward selected message
// types to `fileTreeHost.handleMessage()`. A bug where one of those
// providers forgot to forward `request-file-tree-search` (i.e., the search
// RPC silently lost) is exactly the kind of regression these tests guard.

import { describe, expect, it, vi } from "vitest";
import type { RequestFileTreeSearchMessage, WebViewToExtensionMessage } from "../types/messages";
import { FileTreeHost } from "./fileTreeHost";

describe("FileTreeHost.handleMessage", () => {
  it("handles `request-file-tree-search` and posts a response back", async () => {
    const host = new FileTreeHost();
    const posted: unknown[] = [];

    const msg: RequestFileTreeSearchMessage = {
      type: "request-file-tree-search",
      requestId: "rq",
      rootGeneration: 0,
      scopePath: "/some/path/not/in/workspace",
      maxResults: 100,
    };

    const handled = host.handleMessage(msg, (m) => posted.push(m));
    expect(handled).toBe(true);

    // Allow the inner promise to resolve. Without a workspace folder set the
    // host falls into the `OUT_OF_WORKSPACE` branch and posts an error —
    // the exact response content isn't the point. We're asserting that the
    // message TYPE was claimed by the host (the dispatch wiring is the
    // regression target).
    await new Promise((r) => setTimeout(r, 0));
    expect(posted.length).toBe(1);
    expect((posted[0] as { type?: string }).type).toBe("file-tree-search-response");
  });

  it("returns false for messages it doesn't own (e.g. `input`)", () => {
    const host = new FileTreeHost();
    const noopPost = vi.fn();
    const unrelated = { type: "input", tabId: "t", data: "x" } as WebViewToExtensionMessage;
    expect(host.handleMessage(unrelated, noopPost)).toBe(false);
    expect(noopPost).not.toHaveBeenCalled();
  });
});
