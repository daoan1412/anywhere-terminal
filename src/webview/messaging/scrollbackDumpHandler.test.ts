// src/webview/messaging/scrollbackDumpHandler.test.ts
//
// Tests the webview-side handler for the `requestScrollbackDump` message.
// Stubs out xterm Terminal + SerializeAddon so we can assert payload shape +
// dedupe semantics without touching the DOM.

import { describe, expect, it } from "vitest";
import type { ScrollbackDumpMessage } from "../../types/messages";
import { createScrollbackDumpHandler, type ScrollbackDumpDeps, type SerializeAddonLike } from "./scrollbackDumpHandler";

interface FakeTerminal {
  serialised: string;
  bufferLength: number;
  scrollbackCap: number;
  rows: number;
  // Match the shape the handler reads.
  buffer: { normal: { length: number } };
  options: { scrollback: number };
  loadAddon(_addon: unknown): void;
}

function makeTerminal(opts?: Partial<FakeTerminal>): FakeTerminal {
  const t: FakeTerminal = {
    serialised: "line1\r\nline2\r\nline3\r\n",
    bufferLength: 3,
    scrollbackCap: 1000,
    rows: 24,
    loadAddon() {
      /* no-op for tests */
    },
    buffer: { normal: { length: 0 } },
    options: { scrollback: 0 },
    ...opts,
  };
  // Wire derived fields.
  t.buffer.normal.length = t.bufferLength;
  t.options.scrollback = t.scrollbackCap;
  return t;
}

function makeAddon(payload: string, calls: { count: number }): SerializeAddonLike {
  return {
    serialize() {
      calls.count++;
      return payload;
    },
    dispose() {
      /* no-op */
    },
  };
}

/**
 * Flush any pending microtasks so handler replies (which post inside a
 * `.then()` callback on the internal in-flight Promise) land before assertions.
 * Two awaits guard against handler chains nesting one extra microtask deep.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeDeps(opts: {
  terminals: Map<string, FakeTerminal>;
  posted: ScrollbackDumpMessage[];
  serializeCalls?: { count: number };
}): ScrollbackDumpDeps {
  const calls = opts.serializeCalls ?? { count: 0 };
  return {
    getTerminal(tabId) {
      // FakeTerminal duck-types Terminal for the fields we read.
      return opts.terminals.get(tabId) as unknown as import("@xterm/xterm").Terminal | undefined;
    },
    postMessage(msg) {
      opts.posted.push(msg);
    },
    createSerializeAddon() {
      const term = [...opts.terminals.values()][0];
      return makeAddon(term?.serialised ?? "", calls);
    },
  };
}

describe("scrollbackDumpHandler: happy path", () => {
  it("replies with serialized data + lineCount + truncated=false when under cap", async () => {
    const terminals = new Map([
      ["tab-1", makeTerminal({ serialised: "hello\r\nworld\r\n", bufferLength: 2, scrollbackCap: 1000 })],
    ]);
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));

    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    await flushMicrotasks();

    expect(posted).toEqual([
      {
        type: "scrollbackDump",
        tabId: "tab-1",
        requestId: "req-1",
        data: "hello\r\nworld\r\n",
        lineCount: 2,
        truncated: false,
      },
    ]);
  });

  it("reports truncated=true when buffer length reaches scrollback cap + viewport rows", async () => {
    // The effective cap on `buffer.normal.length` is `scrollback + rows` —
    // see W2 in .reviews/round-2.md. lineCount === scrollback + rows is the
    // boundary that signals "at cap, may be truncating".
    const terminals = new Map([["tab-1", makeTerminal({ bufferLength: 5024, scrollbackCap: 5000, rows: 24 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    await flushMicrotasks();
    expect(posted[0].truncated).toBe(true);
    expect(posted[0].lineCount).toBe(5024);
  });

  it("[W2 round-2] does NOT report truncated when buffer is exactly `rows` lines below the scrollback cap", async () => {
    // Pre-fix, a terminal with `rows=24, scrollback=1000, bufferLength=1000`
    // (i.e. 1000-24 = 976 scrollback lines + 24 viewport = 1000 lines)
    // wrongly reported truncated=true. The viewport-offset correction makes
    // this case correctly report false.
    const terminals = new Map([["tab-1", makeTerminal({ bufferLength: 1000, scrollbackCap: 1000, rows: 24 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    await flushMicrotasks();
    expect(posted[0].truncated).toBe(false);
    expect(posted[0].lineCount).toBe(1000);
  });
});

describe("scrollbackDumpHandler: unknown tab (spec scenario)", () => {
  it("replies with empty payload rather than dropping the request", async () => {
    const terminals = new Map<string, FakeTerminal>();
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));

    handler({ type: "requestScrollbackDump", tabId: "nonexistent", requestId: "req-1" });
    await flushMicrotasks();

    expect(posted).toEqual([
      {
        type: "scrollbackDump",
        tabId: "nonexistent",
        requestId: "req-1",
        data: "",
        lineCount: 0,
        truncated: false,
      },
    ]);
  });
});

describe("scrollbackDumpHandler: dedupe via in-flight Promise (external-review W2)", () => {
  it("collapses N concurrent requests for the same tabId to ONE serialize call (sync arrival)", async () => {
    const terminals = new Map([["tab-1", makeTerminal({ serialised: "shared-payload", bufferLength: 1 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const serializeCalls = { count: 0 };
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted, serializeCalls }));

    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-2" });
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-3" });

    // Pre-resolve nothing has fired yet.
    expect(posted).toEqual([]);
    await flushMicrotasks();

    expect(serializeCalls.count).toBe(1); // one serialize for three requests
    expect(posted).toHaveLength(3);
    for (const reply of posted) {
      expect(reply.data).toBe("shared-payload");
      expect(reply.lineCount).toBe(1);
    }
    // Each requestId echoed correctly.
    expect(posted.map((r) => r.requestId)).toEqual(["req-1", "req-2", "req-3"]);
  });

  it("[W2] dedupes ACROSS separate task boundaries while a serialize is still in flight", async () => {
    // The realistic failure mode the microtask design missed: real postMessage
    // events arrive as DIFFERENT tasks. We simulate that by deferring the
    // addon's creation behind a manually-resolved Promise, then firing the
    // second request between two tasks while the first is still in flight.
    const terminals = new Map([["tab-1", makeTerminal({ serialised: "shared", bufferLength: 1 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const serializeCalls = { count: 0 };
    let resolveAddon: (a: SerializeAddonLike) => void;
    const addonReady = new Promise<SerializeAddonLike>((r) => {
      resolveAddon = r;
    });
    const deps: ScrollbackDumpDeps = {
      getTerminal: (id) => terminals.get(id) as unknown as import("@xterm/xterm").Terminal | undefined,
      postMessage: (m) => posted.push(m),
      createSerializeAddon: () => addonReady,
    };
    const handler = createScrollbackDumpHandler(deps);

    // First request kicks off the serialize (addon creation pending).
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    // Yield to event loop — second request arrives "as a separate task".
    await flushMicrotasks();
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-2" });
    await flushMicrotasks();

    // Still in flight, no replies yet.
    expect(posted).toEqual([]);

    // Resolve the addon → both requests get the SAME payload via one serialize.
    resolveAddon!(makeAddon("shared", serializeCalls));
    await flushMicrotasks();

    expect(serializeCalls.count).toBe(1);
    expect(posted).toHaveLength(2);
    expect(posted.map((r) => r.requestId).sort()).toEqual(["req-1", "req-2"]);
  });

  it("does NOT dedupe across different tabIds", async () => {
    const terminals = new Map([
      ["tab-1", makeTerminal({ serialised: "a", bufferLength: 1 })],
      ["tab-2", makeTerminal({ serialised: "b", bufferLength: 1 })],
    ]);
    const posted: ScrollbackDumpMessage[] = [];
    const serializeCalls = { count: 0 };
    // Use a fresh addon per call so each tab sees its own payload.
    const deps: ScrollbackDumpDeps = {
      getTerminal: (id) => terminals.get(id) as unknown as import("@xterm/xterm").Terminal | undefined,
      postMessage: (m) => posted.push(m),
      createSerializeAddon: () => {
        const which = serializeCalls.count === 0 ? "a" : "b";
        serializeCalls.count++;
        return { serialize: () => which, dispose() {} };
      },
    };
    const handler = createScrollbackDumpHandler(deps);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r1" });
    handler({ type: "requestScrollbackDump", tabId: "tab-2", requestId: "r2" });
    await flushMicrotasks();
    expect(serializeCalls.count).toBe(2);
    expect(posted).toHaveLength(2);
  });

  it("a second wave of requests after the first completes triggers a fresh serialize", async () => {
    const terminals = new Map([["tab-1", makeTerminal({ serialised: "wave-data", bufferLength: 1 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const serializeCalls = { count: 0 };
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted, serializeCalls }));

    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "wave1" });
    await flushMicrotasks();
    expect(serializeCalls.count).toBe(1);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "wave2" });
    await flushMicrotasks();
    expect(serializeCalls.count).toBe(2); // Fresh serialize after the first flush completed.
  });
});

describe("scrollbackDumpHandler: error path", () => {
  it("disposes the addon after every serialize, even on a throw", async () => {
    let disposed = false;
    const terminals = new Map([["tab-1", makeTerminal()]]);
    const posted: ScrollbackDumpMessage[] = [];
    const deps: ScrollbackDumpDeps = {
      getTerminal: (id) => terminals.get(id) as unknown as import("@xterm/xterm").Terminal | undefined,
      postMessage: (m) => posted.push(m),
      createSerializeAddon: () => ({
        serialize: () => {
          throw new Error("boom");
        },
        dispose: () => {
          disposed = true;
        },
      }),
    };
    const handler = createScrollbackDumpHandler(deps);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r1" });
    await flushMicrotasks();
    // Addon disposal happens regardless of serialize() throwing — the `finally`
    // block in computeDump guarantees it.
    expect(disposed).toBe(true);
  });

  it("[W2 external-review] surfaces the failure via `error` field so the coordinator rejects (not silent empty)", async () => {
    // Pre-fix, a serialize() throw was caught and reported as
    // `{ data: '', lineCount: 0, truncated: false }` — the coordinator
    // resolved with that payload and `exportBuffer` wrote an empty file
    // silently. Now `error` carries the reason; coordinator rejects.
    const terminals = new Map([["tab-1", makeTerminal()]]);
    const posted: ScrollbackDumpMessage[] = [];
    const deps: ScrollbackDumpDeps = {
      getTerminal: (id) => terminals.get(id) as unknown as import("@xterm/xterm").Terminal | undefined,
      postMessage: (m) => posted.push(m),
      createSerializeAddon: () => ({
        serialize: () => {
          throw new Error("SerializeAddon: boom");
        },
        dispose: () => {},
      }),
    };
    const handler = createScrollbackDumpHandler(deps);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r1" });
    await flushMicrotasks();
    expect(posted).toHaveLength(1);
    expect(posted[0].error).toBe("SerializeAddon: boom");
    // Placeholders for the typed schema (consumers MUST NOT read these when error is set).
    expect(posted[0].data).toBe("");
    expect(posted[0].lineCount).toBe(0);
    expect(posted[0].truncated).toBe(false);
  });

  it("[W2] surfaces async addon-loader rejections as `error` too (covers dynamic-import failure)", async () => {
    const terminals = new Map([["tab-1", makeTerminal()]]);
    const posted: ScrollbackDumpMessage[] = [];
    const deps: ScrollbackDumpDeps = {
      getTerminal: (id) => terminals.get(id) as unknown as import("@xterm/xterm").Terminal | undefined,
      postMessage: (m) => posted.push(m),
      createSerializeAddon: () => Promise.reject(new Error("module load failed")),
    };
    const handler = createScrollbackDumpHandler(deps);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r-async" });
    await flushMicrotasks();
    expect(posted[0].error).toBe("module load failed");
  });

  it("[W2] error replies are still broadcast to ALL queued requestIds for the same tabId", async () => {
    const terminals = new Map([["tab-1", makeTerminal()]]);
    const posted: ScrollbackDumpMessage[] = [];
    let resolveAddon: (a: SerializeAddonLike) => void;
    const addonReady = new Promise<SerializeAddonLike>((r) => {
      resolveAddon = r;
    });
    const deps: ScrollbackDumpDeps = {
      getTerminal: (id) => terminals.get(id) as unknown as import("@xterm/xterm").Terminal | undefined,
      postMessage: (m) => posted.push(m),
      createSerializeAddon: () => addonReady,
    };
    const handler = createScrollbackDumpHandler(deps);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r1" });
    await flushMicrotasks();
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r2" });
    await flushMicrotasks();
    resolveAddon!({
      serialize: () => {
        throw new Error("late-stage failure");
      },
      dispose: () => {},
    });
    await flushMicrotasks();
    expect(posted).toHaveLength(2);
    for (const m of posted) {
      expect(m.error).toBe("late-stage failure");
    }
  });
});
