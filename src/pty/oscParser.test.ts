// src/pty/oscParser.test.ts — Unit tests for the OSC 7 / OSC 633 cwd parser.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOscParser } from "./oscParser";
import type { ShellIntegrationEvent, ShellIntegrationSink } from "./ShellIntegrationEvents";

/** Collect cwd events into a string array. */
function cwdsOf(out: string[]): ShellIntegrationSink {
  return (event) => {
    if (event.kind === "cwd") out.push(event.cwd);
  };
}

/** Collect every event verbatim. */
function eventsOf(out: ShellIntegrationEvent[]): ShellIntegrationSink {
  return (event) => {
    out.push(event);
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

const BEL = "\x07";
const ST = "\x1b\\";

function osc7(payload: string, term: string = BEL): string {
  return `\x1b]7;${payload}${term}`;
}

function osc633Cwd(rawPath: string, term: string = ST): string {
  return `\x1b]633;P;Cwd=${rawPath}${term}`;
}

function collect(seq: string): string[] {
  const parser = createOscParser();
  const out: string[] = [];
  parser.feed(seq, (event) => {
    if (event.kind === "cwd") out.push(event.cwd);
  });
  return out;
}

// Deterministic LCG for fuzz tests.
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// ─── OSC 7 ──────────────────────────────────────────────────────────

describe("oscParser: OSC 7", () => {
  it("(a) emits decoded path with BEL terminator", () => {
    expect(collect(osc7("file:///foo/bar", BEL))).toEqual(["/foo/bar"]);
  });

  it("(b) emits decoded path with ST terminator", () => {
    expect(collect(osc7("file:///foo/bar", ST))).toEqual(["/foo/bar"]);
  });

  it("(c) percent-decodes the path", () => {
    expect(collect(osc7("file:///foo%20bar/baz"))).toEqual(["/foo bar/baz"]);
  });

  it("accepts non-local hostnames (SSH-style emits)", () => {
    expect(collect(osc7("file://myhost/srv/app"))).toEqual(["/srv/app"]);
  });

  it("(f) silently rejects malformed URLs", () => {
    expect(collect(osc7("not a url"))).toEqual([]);
  });

  it("(g) silently rejects relative payloads (URL parser fails)", () => {
    expect(collect(osc7("relative/path"))).toEqual([]);
  });

  it("(h) rejects payloads containing percent-encoded null bytes", () => {
    expect(collect(osc7("file:///foo%00bar"))).toEqual([]);
  });
});

// ─── OSC 633 ────────────────────────────────────────────────────────

describe("oscParser: OSC 633", () => {
  it("(d) emits cwd from P;Cwd= report", () => {
    expect(collect(osc633Cwd("/foo/bar"))).toEqual(["/foo/bar"]);
  });

  it("accepts BEL terminator", () => {
    expect(collect(osc633Cwd("/foo/bar", BEL))).toEqual(["/foo/bar"]);
  });

  it("does NOT URL-decode (raw paths only)", () => {
    expect(collect(osc633Cwd("/foo%20bar"))).toEqual(["/foo%20bar"]);
  });

  it("ignores non-Cwd OSC 633 sub-commands", () => {
    // OSC 633 also emits A, B, C, D, E sub-commands per VS Code shell integration.
    const seq = "\x1b]633;A\x07\x1b]633;B\x07\x1b]633;C\x07\x1b]633;D\x07\x1b]633;E;cmd\x07";
    expect(collect(seq)).toEqual([]);
  });

  it("rejects relative payloads via isAbsolute check", () => {
    // P;Cwd=relative — path.isAbsolute("relative") is false → reject.
    expect(collect(osc633Cwd("relative/path"))).toEqual([]);
  });

  it("rejects raw null bytes in payload", () => {
    expect(collect(osc633Cwd("/foo\0bar"))).toEqual([]);
  });

  it("rejects raw ESC/CR/control chars in payload (defense in depth)", () => {
    expect(collect(osc633Cwd("/foo\x1bbar"))).toEqual([]);
    expect(collect(osc633Cwd("/foo\rbar"))).toEqual([]);
    expect(collect(osc633Cwd("/foo\x7fbar"))).toEqual([]);
  });
});

// ─── Chunk boundary splits ──────────────────────────────────────────

describe("oscParser: chunk-boundary splits", () => {
  it("(e) parametric: split at every byte offset, fires exactly once with decoded path", () => {
    const seq = osc7("file:///abc/def/ghi", BEL);
    for (let offset = 1; offset < seq.length; offset++) {
      const parser = createOscParser();
      const out: string[] = [];
      parser.feed(seq.slice(0, offset), cwdsOf(out));
      parser.feed(seq.slice(offset), cwdsOf(out));
      expect(out, `split at offset ${offset}`).toEqual(["/abc/def/ghi"]);
    }
  });

  it("handles split right before ST's trailing backslash", () => {
    const seq = osc7("file:///x", ST);
    // ST is "\x1b\\" (2 bytes). Split between them.
    const splitIdx = seq.lastIndexOf("\x1b");
    const parser = createOscParser();
    const out: string[] = [];
    parser.feed(seq.slice(0, splitIdx + 1), cwdsOf(out));
    parser.feed(seq.slice(splitIdx + 1), cwdsOf(out));
    expect(out).toEqual(["/x"]);
  });

  it("emits multiple cwds in a single feed", () => {
    const seq = `${osc7("file:///one")}intervening text${osc7("file:///two")}`;
    expect(collect(seq)).toEqual(["/one", "/two"]);
  });

  it("emits cwds spread across many feeds", () => {
    const parser = createOscParser();
    const out: string[] = [];
    const onCwd = cwdsOf(out);
    parser.feed("first ", onCwd);
    parser.feed(osc7("file:///alpha"), onCwd);
    parser.feed(" between ", onCwd);
    parser.feed(osc633Cwd("/beta"), onCwd);
    parser.feed(" end", onCwd);
    expect(out).toEqual(["/alpha", "/beta"]);
  });
});

// ─── Overflow handling ──────────────────────────────────────────────

describe("oscParser: overflow", () => {
  it("(i) MAX_PENDING overflow: feed 5000 bytes without terminator → no crash, no call", () => {
    const parser = createOscParser();
    const out: string[] = [];
    expect(() => {
      parser.feed(`\x1b]7;file:///${"A".repeat(5000)}`, cwdsOf(out));
    }).not.toThrow();
    expect(out).toEqual([]);
  });

  it("resumes scanning at next OSC 7 boundary after overflow", () => {
    const parser = createOscParser();
    const out: string[] = [];
    // Burn through the buffer with an unterminated OSC.
    parser.feed(`\x1b]7;file:///${"X".repeat(5000)}`, cwdsOf(out));
    // Now send a clean OSC 7 — it should be picked up.
    parser.feed(osc7("file:///recovered"), cwdsOf(out));
    expect(out).toEqual(["/recovered"]);
  });
});

// ─── Unknown OSCs ───────────────────────────────────────────────────

describe("oscParser: unknown OSCs", () => {
  it("(j) skips OSC 0 (window title)", () => {
    const seq = `\x1b]0;Window Title\x07${osc7("file:///wt")}`;
    expect(collect(seq)).toEqual(["/wt"]);
  });

  it("(j) skips OSC 8 (hyperlink)", () => {
    const seq = `\x1b]8;;https://example.com\x1b\\Click here\x1b]8;;\x1b\\${osc7("file:///hl")}`;
    expect(collect(seq)).toEqual(["/hl"]);
  });

  it("(j) skips OSC 52 (clipboard)", () => {
    const seq = `\x1b]52;c;dGVzdA==\x07${osc7("file:///clip")}`;
    expect(collect(seq)).toEqual(["/clip"]);
  });

  it("(j) skips OSC 1337 (iTerm2 proprietary)", () => {
    const seq = `\x1b]1337;CurrentDir=/somewhere\x07${osc7("file:///iterm")}`;
    expect(collect(seq)).toEqual(["/iterm"]);
  });

  it("ignores stray ESC ] without digits", () => {
    const seq = `\x1b]not-an-osc\x07${osc7("file:///after")}`;
    expect(collect(seq)).toEqual(["/after"]);
  });
});

// ─── Robustness / property fuzz ─────────────────────────────────────

describe("oscParser: property/fuzz", () => {
  // Helper: assemble a random sequence drawn from a mix of byte categories.
  function randomSequence(rng: () => number, chunkCount: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const category = Math.floor(rng() * 8);
      switch (category) {
        case 0: // plain printable ASCII
          chunks.push(`text-${Math.floor(rng() * 1_000_000).toString(16)}`);
          break;
        case 1: // lone ESC
          chunks.push("\x1b");
          break;
        case 2: // BEL
          chunks.push("\x07");
          break;
        case 3: // ST
          chunks.push("\x1b\\");
          break;
        case 4: // complete OSC 7 (valid path)
          chunks.push(osc7(`file:///path/${Math.floor(rng() * 1_000_000)}`, rng() < 0.5 ? BEL : ST));
          break;
        case 5: // complete OSC 633 (valid path)
          chunks.push(osc633Cwd(`/cwd/${Math.floor(rng() * 1_000_000)}`, rng() < 0.5 ? BEL : ST));
          break;
        case 6: // OSC 52 payload (must be ignored)
          chunks.push(`\x1b]52;c;${Math.floor(rng() * 1_000_000).toString(36)}\x07`);
          break;
        case 7: // unknown ESC sequence
          chunks.push(`\x1b]${Math.floor(rng() * 9999)};random\x07`);
          break;
      }
    }
    return chunks;
  }

  it("(k) 200 random sequences: never throws AND all emitted cwds are absolute", () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < 200; i++) {
      const parser = createOscParser();
      const emitted: string[] = [];
      const chunks = randomSequence(rng, 1 + Math.floor(rng() * 50));
      const recorded: string[] = [];
      expect(() => {
        for (const chunk of chunks) {
          recorded.push(chunk);
          parser.feed(chunk, cwdsOf(emitted));
        }
      }, `seq #${i}`).not.toThrow();
      // Every emitted cwd must be absolute (D3 invariant).
      for (const cwd of emitted) {
        expect(cwd.startsWith("/"), `cwd "${cwd}" should be absolute (seq #${i})`).toBe(true);
        expect(cwd.includes("\0"), `cwd "${cwd}" must not contain null byte`).toBe(false);
      }
      // Pass-through equivalence: the parser does not modify or consume the
      // bytes given to it. Concatenation of inputs is whatever the recorder
      // saw, byte-identical (parser does not own forwarding — PtySession
      // does, but feed must not mutate its argument).
      expect(recorded.join("")).toEqual(chunks.join(""));
    }
  });
});

// ─── Defensive ──────────────────────────────────────────────────────

describe("oscParser: defensive", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("does not throw on an empty chunk", () => {
    const parser = createOscParser();
    expect(() => parser.feed("", () => {})).not.toThrow();
  });

  it("does not throw on a chunk that is only ESC", () => {
    const parser = createOscParser();
    expect(() => parser.feed("\x1b", () => {})).not.toThrow();
  });

  it("does not throw on bare BEL or ST without context", () => {
    const parser = createOscParser();
    expect(() => parser.feed("\x07\x1b\\", () => {})).not.toThrow();
  });

  it("does not log to console.warn for any of the rejection paths", () => {
    collect(osc7("not a url"));
    collect(osc7("file:///foo%00bar"));
    collect(osc633Cwd("relative"));
    expect(warn).not.toHaveBeenCalled();
  });
});

// ─── OSC 633 command-boundary markers (A/B/C/D/E) ───────────────────

function osc633(payload: string, term: string = ST): string {
  return `\x1b]633;${payload}${term}`;
}

describe("oscParser: OSC 633 markers", () => {
  it("(A) prompt-start emits promptStart", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("A"), eventsOf(events));
    expect(events).toEqual([{ kind: "promptStart" }]);
  });

  it("(B) command-input end emits commandStart", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("B"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandStart" }]);
  });

  it("(C) pre-execution emits commandStart (same kind as B)", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("C"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandStart" }]);
  });

  it("(D) bare emits commandEnd with exitCode=null", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("D"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandEnd", exitCode: null }]);
  });

  it("(D;0) emits commandEnd with exitCode=0", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("D;0"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandEnd", exitCode: 0 }]);
  });

  it("(D;127) emits commandEnd with exitCode=127", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("D;127"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandEnd", exitCode: 127 }]);
  });

  it("(D;-1) accepts negative exit codes (signals)", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("D;-1"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandEnd", exitCode: -1 }]);
  });

  it("(D;xyz) non-numeric exit-code arg → exitCode=null", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("D;xyz"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandEnd", exitCode: null }]);
  });

  it("(E;cmd) with no nonce param → commandLine, nonceValid=false", () => {
    const parser = createOscParser();
    parser.setNonce("abc123");
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;ls -la"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandLine", commandLine: "ls -la", nonceValid: false }]);
  });

  it("(E;cmd;nonce) with matching nonce → nonceValid=true", () => {
    const parser = createOscParser();
    parser.setNonce("abc123");
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;ls -la;abc123"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandLine", commandLine: "ls -la", nonceValid: true }]);
  });

  it("(E;cmd;nonce) with mismatched nonce → nonceValid=false", () => {
    const parser = createOscParser();
    parser.setNonce("abc123");
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;ls -la;DIFFERENT"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandLine", commandLine: "ls -la", nonceValid: false }]);
  });

  it("(E) parser without setNonce never validates", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;ls -la;abc123"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandLine", commandLine: "ls -la", nonceValid: false }]);
  });

  it("(E) unescapes \\x3b → ; in commandLine", () => {
    // VS Code's __vsc_escape_value encodes `;` in command lines as `\x3b`
    // so a raw `;` split on the payload is safe.
    const parser = createOscParser();
    parser.setNonce("n");
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;echo a\\x3b echo b;n"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandLine", commandLine: "echo a; echo b", nonceValid: true }]);
  });

  it("(E) unescapes doubled backslash", () => {
    const parser = createOscParser();
    parser.setNonce("n");
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;path C:\\\\dev;n"), eventsOf(events));
    expect(events).toEqual([{ kind: "commandLine", commandLine: "path C:\\dev", nonceValid: true }]);
  });

  it("P;Cwd= still emits a cwd event (regression — existing behaviour)", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("P;Cwd=/foo/bar"), eventsOf(events));
    expect(events).toEqual([{ kind: "cwd", cwd: "/foo/bar" }]);
  });

  it("P;Prompt= and P;IsWindows= are ignored (only Cwd consumed)", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("P;Prompt=$ "), eventsOf(events));
    parser.feed(osc633("P;IsWindows=True"), eventsOf(events));
    parser.feed(osc633("P;ContinuationPrompt=> "), eventsOf(events));
    expect(events).toEqual([]);
  });

  it("unknown sub-command (e.g. 'Z') is silently ignored", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("Z"), eventsOf(events));
    parser.feed(osc633("Z;extra"), eventsOf(events));
    expect(events).toEqual([]);
  });

  it("malformed D (no separator, e.g. 'Dabc') is ignored", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("Dabc"), eventsOf(events));
    expect(events).toEqual([]);
  });

  it("malformed E (no separator, e.g. 'Eabc') is ignored", () => {
    const parser = createOscParser();
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("Eabc"), eventsOf(events));
    expect(events).toEqual([]);
  });

  it("full command lifecycle A → B → E → C → D;0 in one feed", () => {
    const parser = createOscParser();
    parser.setNonce("nonce-xyz");
    const events: ShellIntegrationEvent[] = [];
    const stream =
      osc633("A") +
      osc633("B") +
      osc633("E;pnpm test;nonce-xyz") +
      "output from pnpm test...\n" +
      osc633("C") +
      osc633("D;0");
    parser.feed(stream, eventsOf(events));
    expect(events).toEqual([
      { kind: "promptStart" },
      { kind: "commandStart" }, // B
      { kind: "commandLine", commandLine: "pnpm test", nonceValid: true },
      { kind: "commandStart" }, // C — consumer must dedupe
      { kind: "commandEnd", exitCode: 0 },
    ]);
  });

  it("nonce can be changed mid-session via setNonce", () => {
    const parser = createOscParser();
    parser.setNonce("old");
    const events: ShellIntegrationEvent[] = [];
    parser.feed(osc633("E;cmd1;old"), eventsOf(events));
    parser.setNonce("new");
    parser.feed(osc633("E;cmd2;new"), eventsOf(events));
    parser.feed(osc633("E;cmd3;old"), eventsOf(events));
    expect(events).toEqual([
      { kind: "commandLine", commandLine: "cmd1", nonceValid: true },
      { kind: "commandLine", commandLine: "cmd2", nonceValid: true },
      { kind: "commandLine", commandLine: "cmd3", nonceValid: false },
    ]);
  });

  it("OSC 633 marker chunk-split across two feeds still emits exactly one event", () => {
    const seq = osc633("D;0");
    for (let offset = 1; offset < seq.length; offset++) {
      const parser = createOscParser();
      const events: ShellIntegrationEvent[] = [];
      parser.feed(seq.slice(0, offset), eventsOf(events));
      parser.feed(seq.slice(offset), eventsOf(events));
      expect(events, `split at offset ${offset}`).toEqual([{ kind: "commandEnd", exitCode: 0 }]);
    }
  });
});
