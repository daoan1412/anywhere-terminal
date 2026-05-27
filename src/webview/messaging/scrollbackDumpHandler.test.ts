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
 * Synchronous microtask scheduler — the handler is designed to flush within
 * a microtask, so for tests we invoke immediately and assert.
 */
function syncScheduler(fn: () => void): void {
  fn();
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
    scheduleMicrotask: syncScheduler,
  };
}

describe("scrollbackDumpHandler: happy path", () => {
  it("replies with serialized data + lineCount + truncated=false when under cap", () => {
    const terminals = new Map([
      ["tab-1", makeTerminal({ serialised: "hello\r\nworld\r\n", bufferLength: 2, scrollbackCap: 1000 })],
    ]);
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));

    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });

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

  it("reports truncated=true when buffer length reaches scrollback cap + viewport rows", () => {
    // The effective cap on `buffer.normal.length` is `scrollback + rows` —
    // see W2 in .reviews/round-2.md. lineCount === scrollback + rows is the
    // boundary that signals "at cap, may be truncating".
    const terminals = new Map([["tab-1", makeTerminal({ bufferLength: 5024, scrollbackCap: 5000, rows: 24 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    expect(posted[0].truncated).toBe(true);
    expect(posted[0].lineCount).toBe(5024);
  });

  it("[W2] does NOT report truncated when buffer is exactly `rows` lines below the scrollback cap", () => {
    // Pre-fix, a terminal with `rows=24, scrollback=1000, bufferLength=1000`
    // (i.e. 1000-24 = 976 scrollback lines + 24 viewport = 1000 lines)
    // wrongly reported truncated=true. The viewport-offset correction makes
    // this case correctly report false.
    const terminals = new Map([["tab-1", makeTerminal({ bufferLength: 1000, scrollbackCap: 1000, rows: 24 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    expect(posted[0].truncated).toBe(false);
    expect(posted[0].lineCount).toBe(1000);
  });
});

describe("scrollbackDumpHandler: unknown tab (spec scenario)", () => {
  it("replies with empty payload rather than dropping the request", () => {
    const terminals = new Map<string, FakeTerminal>();
    const posted: ScrollbackDumpMessage[] = [];
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted }));

    handler({ type: "requestScrollbackDump", tabId: "nonexistent", requestId: "req-1" });

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

describe("scrollbackDumpHandler: dedupe (F5 fix)", () => {
  it("collapses N concurrent requests for the same tabId to ONE serialize call", () => {
    const terminals = new Map([["tab-1", makeTerminal({ serialised: "shared-payload", bufferLength: 1 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const serializeCalls = { count: 0 };
    // Defer microtask so we can flush manually.
    const scheduledRef: { fn: (() => void) | null } = { fn: null };
    const deps: ScrollbackDumpDeps = {
      ...makeDeps({ terminals, posted, serializeCalls }),
      scheduleMicrotask: (fn) => {
        scheduledRef.fn = fn;
      },
    };
    const handler = createScrollbackDumpHandler(deps);

    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-1" });
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-2" });
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "req-3" });

    // No replies yet — they wait on the microtask.
    expect(posted).toEqual([]);
    scheduledRef.fn?.();

    expect(serializeCalls.count).toBe(1); // one serialize for three requests
    expect(posted).toHaveLength(3);
    for (const reply of posted) {
      expect(reply.data).toBe("shared-payload");
      expect(reply.lineCount).toBe(1);
    }
    // Each requestId echoed correctly.
    expect(posted.map((r) => r.requestId)).toEqual(["req-1", "req-2", "req-3"]);
  });

  it("does NOT dedupe across different tabIds", () => {
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
      scheduleMicrotask: syncScheduler,
    };
    const handler = createScrollbackDumpHandler(deps);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r1" });
    handler({ type: "requestScrollbackDump", tabId: "tab-2", requestId: "r2" });
    expect(serializeCalls.count).toBe(2);
    expect(posted).toHaveLength(2);
  });

  it("a second wave of requests after a flush triggers a fresh serialize", () => {
    const terminals = new Map([["tab-1", makeTerminal({ serialised: "wave-data", bufferLength: 1 })]]);
    const posted: ScrollbackDumpMessage[] = [];
    const serializeCalls = { count: 0 };
    const handler = createScrollbackDumpHandler(makeDeps({ terminals, posted, serializeCalls }));

    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "wave1" });
    expect(serializeCalls.count).toBe(1);
    handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "wave2" });
    expect(serializeCalls.count).toBe(2); // Fresh serialize after the first flush completed.
  });
});

describe("scrollbackDumpHandler: side-effect hygiene", () => {
  it("disposes the addon after every serialize, even on a throw", () => {
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
      scheduleMicrotask: syncScheduler,
    };
    const handler = createScrollbackDumpHandler(deps);
    expect(() => handler({ type: "requestScrollbackDump", tabId: "tab-1", requestId: "r1" })).toThrow();
    expect(disposed).toBe(true);
  });
});
