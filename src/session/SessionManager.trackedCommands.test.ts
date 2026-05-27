// src/session/SessionManager.trackedCommands.test.ts
// Unit tests for the OSC 633 → CommandTracker state machine.
//
// These tests exercise the CommandTracker class directly (no SessionManager,
// no PTY mocks needed). The integration with SessionManager is covered by
// the existing PtySession.test.ts split-chunk regression tests after the
// parser API was migrated in task 2_2.

import { describe, expect, it } from "vitest";
import {
  CommandTracker,
  MAX_COMMANDS_PER_SESSION,
  MAX_OUTPUT_PER_COMMAND,
  MAX_TOTAL_OUTPUT_PER_SESSION,
  type TrackedCommand,
} from "./TrackedCommand";

let idCounter = 0;
function nextId(): string {
  idCounter++;
  return `cmd-${idCounter.toString().padStart(4, "0")}`;
}

describe("CommandTracker: lifecycle", () => {
  it("open creates an in-flight command with the right shape", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: "/home/user" });
    expect(tr.inFlight).not.toBeNull();
    expect(tr.inFlight).toMatchObject({
      commandLine: "",
      output: "",
      exitCode: null,
      cwd: "/home/user",
      startedAt: 1000,
      endedAt: null,
      outputChars: 0,
      outputTruncated: false,
    });
    expect(tr.commands).toEqual([]);
  });

  it("open is idempotent when a command is already in flight (B then C)", () => {
    const tr = new CommandTracker();
    tr.open({ id: "first", now: 1000, cwd: null });
    tr.open({ id: "second", now: 2000, cwd: null });
    expect(tr.inFlight?.id).toBe("first");
    expect(tr.inFlight?.startedAt).toBe(1000);
  });

  it("setCommandLine populates commandLine on the open command", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    tr.setCommandLine("pnpm test");
    expect(tr.inFlight?.commandLine).toBe("pnpm test");
  });

  it("setCommandLine is a no-op when nothing is in flight", () => {
    const tr = new CommandTracker();
    tr.setCommandLine("should not appear");
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toEqual([]);
  });

  it("close pushes to commands and clears inFlight", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: "/srv" });
    tr.setCommandLine("ls");
    tr.appendOutput("file1\nfile2\n");
    tr.close({ exitCode: 0, now: 2000 });
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toHaveLength(1);
    expect(tr.commands[0]).toMatchObject({
      commandLine: "ls",
      output: "file1\nfile2\n",
      exitCode: 0,
      cwd: "/srv",
      startedAt: 1000,
      endedAt: 2000,
      outputChars: "file1\nfile2\n".length,
      outputTruncated: false,
    });
  });

  it("close is a no-op when nothing is in flight (stray D)", () => {
    const tr = new CommandTracker();
    tr.close({ exitCode: 0, now: 1000 });
    expect(tr.commands).toEqual([]);
  });

  it("close with exitCode=null records null (D without arg)", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    tr.close({ exitCode: null, now: 2000 });
    expect(tr.commands[0].exitCode).toBeNull();
  });

  it("abandonInFlight drops the in-flight without pushing to commands", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    tr.appendOutput("some data");
    tr.abandonInFlight();
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toEqual([]);
  });
});

describe("CommandTracker: appendOutput cap (F4 — append-time enforcement)", () => {
  it("appends below cap when remaining capacity is sufficient", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    tr.appendOutput("hello");
    tr.appendOutput(" world");
    expect(tr.inFlight?.output).toBe("hello world");
    expect(tr.inFlight?.outputChars).toBe(11);
    expect(tr.inFlight?.outputTruncated).toBe(false);
  });

  it("truncates exactly at MAX_OUTPUT_PER_COMMAND on a single oversize append", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    const blob = "x".repeat(MAX_OUTPUT_PER_COMMAND + 1234);
    tr.appendOutput(blob);
    expect(tr.inFlight?.output.length).toBe(MAX_OUTPUT_PER_COMMAND);
    expect(tr.inFlight?.outputChars).toBe(MAX_OUTPUT_PER_COMMAND + 1234);
    expect(tr.inFlight?.outputTruncated).toBe(true);
  });

  it("truncates across multiple appends (gradual fill)", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    tr.appendOutput("a".repeat(MAX_OUTPUT_PER_COMMAND - 100));
    expect(tr.inFlight?.outputTruncated).toBe(false);
    tr.appendOutput("b".repeat(500));
    expect(tr.inFlight?.output.length).toBe(MAX_OUTPUT_PER_COMMAND);
    expect(tr.inFlight?.outputChars).toBe(MAX_OUTPUT_PER_COMMAND - 100 + 500);
    expect(tr.inFlight?.outputTruncated).toBe(true);
  });

  it("after truncation, subsequent appends only count bytes (no string growth)", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    tr.appendOutput("x".repeat(MAX_OUTPUT_PER_COMMAND + 100));
    const trimmedLen = tr.inFlight!.output.length;
    tr.appendOutput("y".repeat(5000));
    expect(tr.inFlight?.output.length).toBe(trimmedLen);
    expect(tr.inFlight?.outputChars).toBe(MAX_OUTPUT_PER_COMMAND + 100 + 5000);
  });

  it("never-closing command (cat /dev/urandom equivalent) stays under 100 KB", () => {
    const tr = new CommandTracker();
    tr.open({ id: nextId(), now: 1000, cwd: null });
    // Simulate streaming 10 MB without ever firing D.
    for (let i = 0; i < 1024; i++) {
      tr.appendOutput("z".repeat(10_000));
    }
    expect(tr.inFlight?.output.length).toBe(MAX_OUTPUT_PER_COMMAND);
    expect(tr.inFlight?.outputTruncated).toBe(true);
    expect(tr.inFlight?.outputChars).toBe(10_240_000);
  });

  it("appendOutput is a no-op when nothing is in flight", () => {
    const tr = new CommandTracker();
    tr.appendOutput("stray data");
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toEqual([]);
  });
});

describe("CommandTracker: eviction (D5)", () => {
  it("FIFO eviction at MAX_COMMANDS_PER_SESSION + 1", () => {
    const tr = new CommandTracker();
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION; i++) {
      tr.open({ id: `cmd-${i}`, now: i, cwd: null });
      tr.close({ exitCode: 0, now: i + 1 });
    }
    expect(tr.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    // Fire one more — should drop the oldest.
    tr.open({ id: "cmd-overflow", now: 999, cwd: null });
    tr.close({ exitCode: 0, now: 1000 });
    expect(tr.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    expect(tr.commands[0].id).toBe("cmd-1"); // cmd-0 dropped
    expect(tr.commands[tr.commands.length - 1].id).toBe("cmd-overflow");
  });

  it("evicts based on total-output-bytes when entry count is below cap", () => {
    // Each command holds 100 KB. 1 MB total cap → after 11 commands we exceed.
    const tr = new CommandTracker();
    const bigChunk = "x".repeat(MAX_OUTPUT_PER_COMMAND);
    for (let i = 0; i < 11; i++) {
      tr.open({ id: `cmd-${i}`, now: i, cwd: null });
      tr.appendOutput(bigChunk);
      tr.close({ exitCode: 0, now: i + 1 });
    }
    expect(tr.commands).toHaveLength(10);
    expect(tr.commands[0].id).toBe("cmd-1");
  });

  it("does not evict when both caps are respected (boundary at 1 MB - 1)", () => {
    const tr = new CommandTracker();
    // 9 × 100 KB = 900 KB → under 1 MB.
    for (let i = 0; i < 9; i++) {
      tr.open({ id: `cmd-${i}`, now: i, cwd: null });
      tr.appendOutput("x".repeat(MAX_OUTPUT_PER_COMMAND));
      tr.close({ exitCode: 0, now: i + 1 });
    }
    expect(tr.commands).toHaveLength(9);
  });

  it("eviction only runs after close, not after open or appendOutput", () => {
    const tr = new CommandTracker();
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION; i++) {
      tr.open({ id: `cmd-${i}`, now: i, cwd: null });
      tr.close({ exitCode: 0, now: i + 1 });
    }
    tr.open({ id: "cmd-pending", now: 999, cwd: null });
    tr.appendOutput("in-flight data");
    expect(tr.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    expect(tr.inFlight?.id).toBe("cmd-pending");
  });
});

describe("CommandTracker: lastCompleted", () => {
  it("returns null on an empty tracker", () => {
    const tr = new CommandTracker();
    expect(tr.lastCompleted).toBeNull();
  });

  it("returns the most-recently-closed command", () => {
    const tr = new CommandTracker();
    tr.open({ id: "a", now: 100, cwd: null });
    tr.close({ exitCode: 0, now: 200 });
    tr.open({ id: "b", now: 300, cwd: null });
    tr.close({ exitCode: 1, now: 400 });
    expect(tr.lastCompleted?.id).toBe("b");
  });

  it("skips an in-flight command and returns the previous completed (spec scenario)", () => {
    const tr = new CommandTracker();
    tr.open({ id: "completed", now: 100, cwd: null });
    tr.close({ exitCode: 0, now: 200 });
    tr.open({ id: "in-flight", now: 300, cwd: null });
    expect(tr.lastCompleted?.id).toBe("completed");
  });
});

describe("CommandTracker: spec scenarios", () => {
  it("Per-session eviction holds both caps simultaneously", () => {
    const tr = new CommandTracker();
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION; i++) {
      tr.open({ id: `cmd-${i}`, now: i, cwd: null });
      tr.appendOutput("y".repeat(5000));
      tr.close({ exitCode: 0, now: i + 1 });
    }
    expect(tr.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    const total = tr.commands.reduce((acc, c) => acc + c.output.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_PER_SESSION);
    expect(total).toBe(200 * 5000);
  });
});

describe("CommandTracker: handleEvent (W2 — full state machine)", () => {
  const ctx = { now: 1000, cwd: "/srv", idFactory: () => "cmd-fixed" };

  it("promptStart abandons the in-flight without pushing", () => {
    const tr = new CommandTracker();
    tr.open({ id: "orphan", now: 500, cwd: null });
    tr.appendOutput("noise");
    tr.handleEvent({ kind: "promptStart" }, ctx);
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toEqual([]);
  });

  it("commandStart opens via injected idFactory + ctx values", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "commandStart" }, ctx);
    expect(tr.inFlight).toMatchObject({ id: "cmd-fixed", startedAt: 1000, cwd: "/srv" });
  });

  it("commandLine with nonceValid=true populates the in-flight", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "commandStart" }, ctx);
    tr.handleEvent({ kind: "commandLine", commandLine: "pnpm test", nonceValid: true }, ctx);
    expect(tr.inFlight?.commandLine).toBe("pnpm test");
  });

  it("commandLine with nonceValid=false leaves commandLine empty", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "commandStart" }, ctx);
    tr.handleEvent({ kind: "commandLine", commandLine: "forged", nonceValid: false }, ctx);
    expect(tr.inFlight?.commandLine).toBe("");
  });

  it("commandEnd closes + pushes via ctx.now exitCode", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "commandStart" }, ctx);
    tr.handleEvent({ kind: "commandEnd", exitCode: 0 }, { ...ctx, now: 2000 });
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toHaveLength(1);
    expect(tr.commands[0].endedAt).toBe(2000);
  });

  it("cwd events are ignored by the tracker (routed at the session level)", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "cwd", cwd: "/new" }, ctx);
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toEqual([]);
  });

  // ─── [B1] regression: text events drive appendOutput in source order ──
  // See: asimov/changes/export-terminal-session/.reviews/round-2.md [B1].
  // The parser emits `text` between OSC sequences; `appendOutput` must run
  // BEFORE `commandEnd` closes the in-flight so a single-chunk command
  // `[B][output][D]` doesn't lose its output.

  it("[B1] text event captures output INTO the in-flight command", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "commandStart" }, ctx);
    tr.handleEvent({ kind: "text", text: "hello world\n" }, ctx);
    expect(tr.inFlight?.output).toBe("hello world\n");
  });

  it("[B1] text BEFORE commandStart is dropped (no in-flight)", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "text", text: "prompt-rendering bytes" }, ctx);
    expect(tr.inFlight).toBeNull();
    expect(tr.commands).toEqual([]);
  });

  it("[B1] full single-chunk command lifecycle preserves output", () => {
    const tr = new CommandTracker();
    tr.handleEvent({ kind: "promptStart" }, ctx);
    tr.handleEvent({ kind: "commandStart" }, ctx);
    tr.handleEvent({ kind: "commandLine", commandLine: "pwd", nonceValid: true }, ctx);
    tr.handleEvent({ kind: "text", text: "/home/user\n" }, ctx);
    tr.handleEvent({ kind: "commandEnd", exitCode: 0 }, { ...ctx, now: 2000 });
    expect(tr.commands).toHaveLength(1);
    expect(tr.commands[0]).toMatchObject({
      commandLine: "pwd",
      output: "/home/user\n",
      exitCode: 0,
    });
  });
});

describe("CommandTracker constructor (hydrate)", () => {
  function completed(id: string, output = "ok"): TrackedCommand {
    return {
      id,
      commandLine: `cmd ${id}`,
      output,
      exitCode: 0,
      cwd: "/tmp",
      startedAt: 100,
      endedAt: 200,
      outputChars: output.length,
      outputTruncated: false,
    };
  }

  it("returns a fresh empty tracker for undefined input", () => {
    const tr = new CommandTracker(undefined);
    expect(tr.commands).toEqual([]);
    expect(tr.inFlight).toBeNull();
  });

  it("returns a fresh empty tracker for empty array input", () => {
    const tr = new CommandTracker([]);
    expect(tr.commands).toEqual([]);
    expect(tr.inFlight).toBeNull();
  });

  it("seeds completed commands and never resurrects inFlight", () => {
    const inFlightAtPersistTime: TrackedCommand = { ...completed("c1"), endedAt: null };
    const persisted = [completed("c0"), inFlightAtPersistTime, completed("c2")];
    const tr = new CommandTracker(persisted);
    expect(tr.commands.map((c) => c.id)).toEqual(["c0", "c2"]);
    expect(tr.inFlight).toBeNull();
  });

  it("re-applies the MAX_COMMANDS_PER_SESSION cap (FIFO drop)", () => {
    const persisted: TrackedCommand[] = [];
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION + 25; i++) {
      persisted.push(completed(`c-${i}`));
    }
    const tr = new CommandTracker(persisted);
    expect(tr.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    expect(tr.commands[0].id).toBe(`c-${25}`);
    expect(tr.commands.at(-1)?.id).toBe(`c-${MAX_COMMANDS_PER_SESSION + 25 - 1}`);
  });

  it("re-applies the MAX_TOTAL_OUTPUT_PER_SESSION cap (FIFO drop)", () => {
    const big = "z".repeat(100_000);
    const persisted: TrackedCommand[] = [];
    for (let i = 0; i < 11; i++) {
      persisted.push({ ...completed(`big-${i}`, big), outputChars: big.length });
    }
    const tr = new CommandTracker(persisted);
    const total = tr.commands.reduce((acc, c) => acc + c.output.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_PER_SESSION);
    expect(tr.commands).toHaveLength(10);
    expect(tr.commands[0].id).toBe("big-1");
  });

  it("does not alias the persisted command objects (defensive copy)", () => {
    const original = completed("c0", "before");
    const tr = new CommandTracker([original]);
    // The tracker's commands array is readonly to outsiders, but the
    // underlying object copy is verified by mutating via a cast-and-assign.
    (tr.commands[0] as TrackedCommand).output = "after";
    expect(original.output).toBe("before");
  });
});
