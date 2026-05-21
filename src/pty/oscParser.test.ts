// src/pty/oscParser.test.ts — Unit tests for the OSC 7 / OSC 633 cwd parser.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOscParser } from "./oscParser";

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
  parser.feed(seq, (cwd) => out.push(cwd));
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
      parser.feed(seq.slice(0, offset), (cwd) => out.push(cwd));
      parser.feed(seq.slice(offset), (cwd) => out.push(cwd));
      expect(out, `split at offset ${offset}`).toEqual(["/abc/def/ghi"]);
    }
  });

  it("handles split right before ST's trailing backslash", () => {
    const seq = osc7("file:///x", ST);
    // ST is "\x1b\\" (2 bytes). Split between them.
    const splitIdx = seq.lastIndexOf("\x1b");
    const parser = createOscParser();
    const out: string[] = [];
    parser.feed(seq.slice(0, splitIdx + 1), (cwd) => out.push(cwd));
    parser.feed(seq.slice(splitIdx + 1), (cwd) => out.push(cwd));
    expect(out).toEqual(["/x"]);
  });

  it("emits multiple cwds in a single feed", () => {
    const seq = `${osc7("file:///one")}intervening text${osc7("file:///two")}`;
    expect(collect(seq)).toEqual(["/one", "/two"]);
  });

  it("emits cwds spread across many feeds", () => {
    const parser = createOscParser();
    const out: string[] = [];
    const onCwd = (cwd: string) => out.push(cwd);
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
      parser.feed(`\x1b]7;file:///${"A".repeat(5000)}`, (cwd) => out.push(cwd));
    }).not.toThrow();
    expect(out).toEqual([]);
  });

  it("resumes scanning at next OSC 7 boundary after overflow", () => {
    const parser = createOscParser();
    const out: string[] = [];
    // Burn through the buffer with an unterminated OSC.
    parser.feed(`\x1b]7;file:///${"X".repeat(5000)}`, (cwd) => out.push(cwd));
    // Now send a clean OSC 7 — it should be picked up.
    parser.feed(osc7("file:///recovered"), (cwd) => out.push(cwd));
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
          parser.feed(chunk, (cwd) => emitted.push(cwd));
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
