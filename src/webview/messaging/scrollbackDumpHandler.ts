// src/webview/messaging/scrollbackDumpHandler.ts — Webview-side responder
// for the extension's `requestScrollbackDump` message.
//
// Serialises the xterm.js scrollback via @xterm/addon-serialize and replies
// with the typed `scrollbackDump` payload. Concurrent requests for the same
// `tabId` within one microtask are deduplicated: a single serialise produces
// one payload, every queued `requestId` receives the same data.
//
// See:
//   asimov/changes/export-terminal-session/specs/webview-scrollback-dump/spec.md
//   asimov/changes/export-terminal-session/design.md D4

import type { Terminal } from "@xterm/xterm";
import type { RequestScrollbackDumpMessage, ScrollbackDumpMessage } from "../../types/messages";

/**
 * Minimal subset of `@xterm/addon-serialize`'s SerializeAddon used here.
 * Matches the shape used by extension-side `SnapshotPersistence` so a
 * single shim suits both directions.
 */
export interface SerializeAddonLike {
  serialize(options?: { scrollback?: number; excludeAltBuffer?: boolean; excludeModes?: boolean }): string;
  dispose(): void;
}

export interface ScrollbackDumpDeps {
  /** Look up a terminal by `tabId`. Returns undefined for unknown tabs. */
  getTerminal(tabId: string): Terminal | undefined;
  /**
   * Post a `ScrollbackDumpMessage` back to the extension. Mirrors the
   * existing webview → extension message dispatch (whatever wraps
   * `acquireVsCodeApi().postMessage`).
   */
  postMessage(msg: ScrollbackDumpMessage): void;
  /**
   * Create a fresh `SerializeAddon` instance. Caller decides whether to
   * lazily instantiate one per-tab or one per-dump. In production we create
   * one per dump and dispose immediately — the addon's serialize() reads the
   * Terminal's buffer without attaching to it.
   */
  createSerializeAddon(): SerializeAddonLike;
  /**
   * Microtask scheduler — `queueMicrotask` in production, controllable from
   * tests. We use a microtask boundary so multiple synchronous incoming
   * requests for the same `tabId` collapse to one serialise.
   */
  scheduleMicrotask?: (fn: () => void) => void;
}

interface PendingDump {
  requestId: string;
}

/**
 * Construct a handler closure. The returned function is wired into the
 * webview's MessageRouter for the `requestScrollbackDump` message type.
 */
export function createScrollbackDumpHandler(deps: ScrollbackDumpDeps): (msg: RequestScrollbackDumpMessage) => void {
  const schedule = deps.scheduleMicrotask ?? queueMicrotask;
  const pendingByTab = new Map<string, PendingDump[]>();

  return (msg: RequestScrollbackDumpMessage): void => {
    const queue = pendingByTab.get(msg.tabId);
    if (queue) {
      queue.push({ requestId: msg.requestId });
      return; // Microtask is already scheduled — coalesce.
    }
    const fresh: PendingDump[] = [{ requestId: msg.requestId }];
    pendingByTab.set(msg.tabId, fresh);
    schedule(() => {
      const requests = pendingByTab.get(msg.tabId) ?? [];
      pendingByTab.delete(msg.tabId);
      const payload = computeDump(deps, msg.tabId);
      for (const req of requests) {
        deps.postMessage({
          type: "scrollbackDump",
          tabId: msg.tabId,
          requestId: req.requestId,
          data: payload.data,
          lineCount: payload.lineCount,
          truncated: payload.truncated,
        });
      }
    });
  };
}

interface DumpPayload {
  data: string;
  lineCount: number;
  truncated: boolean;
}

function computeDump(deps: ScrollbackDumpDeps, tabId: string): DumpPayload {
  const terminal = deps.getTerminal(tabId);
  if (!terminal) {
    // Unknown tab → empty payload per spec scenario "Unknown tabId".
    return { data: "", lineCount: 0, truncated: false };
  }
  const addon = deps.createSerializeAddon();
  try {
    terminal.loadAddon(addon as unknown as { activate(t: Terminal): void; dispose(): void });
    const data = addon.serialize();
    const lineCount = terminal.buffer.normal.length;
    // `terminal.buffer.normal.length` returns the total line count INCLUDING
    // the visible viewport rows. The `scrollback` option caps only the
    // scrollback portion ABOVE the viewport, so the effective cap on
    // `buffer.normal.length` is `scrollback + rows`. Without the viewport
    // offset, a terminal at exactly `rows` lines below cap would report
    // `truncated: true` falsely. See: .reviews/round-2.md [W2].
    const scrollbackCap = (terminal.options.scrollback ?? 1000) + terminal.rows;
    const truncated = lineCount >= scrollbackCap;
    return { data, lineCount, truncated };
  } finally {
    try {
      addon.dispose();
    } catch {
      /* best-effort */
    }
  }
}
