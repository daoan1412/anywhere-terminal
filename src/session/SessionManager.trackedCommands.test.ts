// src/session/SessionManager.trackedCommands.test.ts
// Unit tests for the OSC 633 → TrackedCommand state machine.
//
// These tests exercise the pure TrackedCommand runtime (no SessionManager,
// no PTY mocks needed). The integration with SessionManager is covered by
// the existing PtySession.test.ts split-chunk regression tests after the
// parser API was migrated in task 2_2.

import { describe, expect, it } from "vitest";
import {
  appendToCommandOutput,
  closeCommand,
  createCommandTrackingRuntime,
  lastCompleted,
  MAX_COMMANDS_PER_SESSION,
  MAX_OUTPUT_PER_COMMAND,
  MAX_TOTAL_OUTPUT_PER_SESSION,
  openCommand,
  setInFlightCommandLine,
} from "./TrackedCommand";

let idCounter = 0;
function nextId(): string {
  idCounter++;
  return `cmd-${idCounter.toString().padStart(4, "0")}`;
}

describe("TrackedCommand: lifecycle", () => {
  it("openCommand creates an in-flight command with the right shape", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: "/home/user" });
    expect(runtime.inFlight).not.toBeNull();
    expect(runtime.inFlight).toMatchObject({
      commandLine: "",
      output: "",
      exitCode: null,
      cwd: "/home/user",
      startedAt: 1000,
      endedAt: null,
      outputBytes: 0,
      outputTruncated: false,
    });
    expect(runtime.commands).toEqual([]);
  });

  it("openCommand is idempotent when a command is already in flight (B then C)", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: "first", now: 1000, cwd: null });
    openCommand(runtime, { id: "second", now: 2000, cwd: null });
    expect(runtime.inFlight?.id).toBe("first");
    expect(runtime.inFlight?.startedAt).toBe(1000);
  });

  it("setInFlightCommandLine populates commandLine on the open command", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    setInFlightCommandLine(runtime, "pnpm test");
    expect(runtime.inFlight?.commandLine).toBe("pnpm test");
  });

  it("setInFlightCommandLine is a no-op when nothing is in flight", () => {
    const runtime = createCommandTrackingRuntime();
    setInFlightCommandLine(runtime, "should not appear");
    expect(runtime.inFlight).toBeNull();
    expect(runtime.commands).toEqual([]);
  });

  it("closeCommand pushes to commands[] and clears inFlight", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: "/srv" });
    setInFlightCommandLine(runtime, "ls");
    appendToCommandOutput(runtime, "file1\nfile2\n");
    closeCommand(runtime, { exitCode: 0, now: 2000 });
    expect(runtime.inFlight).toBeNull();
    expect(runtime.commands).toHaveLength(1);
    expect(runtime.commands[0]).toMatchObject({
      commandLine: "ls",
      output: "file1\nfile2\n",
      exitCode: 0,
      cwd: "/srv",
      startedAt: 1000,
      endedAt: 2000,
      outputBytes: "file1\nfile2\n".length,
      outputTruncated: false,
    });
  });

  it("closeCommand is a no-op when nothing is in flight (stray D)", () => {
    const runtime = createCommandTrackingRuntime();
    closeCommand(runtime, { exitCode: 0, now: 1000 });
    expect(runtime.commands).toEqual([]);
  });

  it("closeCommand with exitCode=null records null (D without arg)", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    closeCommand(runtime, { exitCode: null, now: 2000 });
    expect(runtime.commands[0].exitCode).toBeNull();
  });
});

describe("TrackedCommand: appendToCommandOutput cap (F4 — append-time enforcement)", () => {
  it("appends below cap when remaining capacity is sufficient", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    appendToCommandOutput(runtime, "hello");
    appendToCommandOutput(runtime, " world");
    expect(runtime.inFlight?.output).toBe("hello world");
    expect(runtime.inFlight?.outputBytes).toBe(11);
    expect(runtime.inFlight?.outputTruncated).toBe(false);
  });

  it("truncates exactly at MAX_OUTPUT_PER_COMMAND on a single oversize append", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    const blob = "x".repeat(MAX_OUTPUT_PER_COMMAND + 1234);
    appendToCommandOutput(runtime, blob);
    expect(runtime.inFlight?.output.length).toBe(MAX_OUTPUT_PER_COMMAND);
    expect(runtime.inFlight?.outputBytes).toBe(MAX_OUTPUT_PER_COMMAND + 1234);
    expect(runtime.inFlight?.outputTruncated).toBe(true);
  });

  it("truncates across multiple appends (gradual fill)", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    appendToCommandOutput(runtime, "a".repeat(MAX_OUTPUT_PER_COMMAND - 100));
    expect(runtime.inFlight?.outputTruncated).toBe(false);
    appendToCommandOutput(runtime, "b".repeat(500));
    expect(runtime.inFlight?.output.length).toBe(MAX_OUTPUT_PER_COMMAND);
    expect(runtime.inFlight?.outputBytes).toBe(MAX_OUTPUT_PER_COMMAND - 100 + 500);
    expect(runtime.inFlight?.outputTruncated).toBe(true);
  });

  it("after truncation, subsequent appends only count bytes (no string growth)", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    appendToCommandOutput(runtime, "x".repeat(MAX_OUTPUT_PER_COMMAND + 100));
    const trimmedLen = runtime.inFlight!.output.length;
    appendToCommandOutput(runtime, "y".repeat(5000));
    expect(runtime.inFlight?.output.length).toBe(trimmedLen);
    expect(runtime.inFlight?.outputBytes).toBe(MAX_OUTPUT_PER_COMMAND + 100 + 5000);
  });

  it("never-closing command (cat /dev/urandom equivalent) stays under 100 KB", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: nextId(), now: 1000, cwd: null });
    // Simulate streaming 10 MB without ever firing D.
    for (let i = 0; i < 1024; i++) {
      appendToCommandOutput(runtime, "z".repeat(10_000));
    }
    expect(runtime.inFlight?.output.length).toBe(MAX_OUTPUT_PER_COMMAND);
    expect(runtime.inFlight?.outputTruncated).toBe(true);
    // 1024 × 10_000 = 10_240_000 bytes — full count preserved.
    expect(runtime.inFlight?.outputBytes).toBe(10_240_000);
  });

  it("appendToCommandOutput is a no-op when nothing is in flight", () => {
    const runtime = createCommandTrackingRuntime();
    appendToCommandOutput(runtime, "stray data");
    expect(runtime.inFlight).toBeNull();
    expect(runtime.commands).toEqual([]);
  });
});

describe("TrackedCommand: eviction (D5)", () => {
  it("FIFO eviction at MAX_COMMANDS_PER_SESSION + 1", () => {
    const runtime = createCommandTrackingRuntime();
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION; i++) {
      openCommand(runtime, { id: `cmd-${i}`, now: i, cwd: null });
      closeCommand(runtime, { exitCode: 0, now: i + 1 });
    }
    expect(runtime.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    // Fire one more — should drop the oldest.
    openCommand(runtime, { id: "cmd-overflow", now: 999, cwd: null });
    closeCommand(runtime, { exitCode: 0, now: 1000 });
    expect(runtime.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    expect(runtime.commands[0].id).toBe("cmd-1"); // cmd-0 dropped
    expect(runtime.commands[runtime.commands.length - 1].id).toBe("cmd-overflow");
  });

  it("evicts based on total-output-bytes when entry count is below cap", () => {
    // Each command holds 100 KB. 1 MB total cap → after 11 commands we exceed.
    const runtime = createCommandTrackingRuntime();
    const bigChunk = "x".repeat(MAX_OUTPUT_PER_COMMAND);
    for (let i = 0; i < 11; i++) {
      openCommand(runtime, { id: `cmd-${i}`, now: i, cwd: null });
      appendToCommandOutput(runtime, bigChunk);
      closeCommand(runtime, { exitCode: 0, now: i + 1 });
    }
    // 11 × 100 KB = 1.1 MB → exceeds 1 MB cap, so oldest should be evicted.
    expect(runtime.commands).toHaveLength(10);
    expect(runtime.commands[0].id).toBe("cmd-1");
  });

  it("does not evict when both caps are respected (boundary at 1 MB - 1)", () => {
    const runtime = createCommandTrackingRuntime();
    // 9 × 100 KB = 900 KB → under 1 MB.
    for (let i = 0; i < 9; i++) {
      openCommand(runtime, { id: `cmd-${i}`, now: i, cwd: null });
      appendToCommandOutput(runtime, "x".repeat(MAX_OUTPUT_PER_COMMAND));
      closeCommand(runtime, { exitCode: 0, now: i + 1 });
    }
    expect(runtime.commands).toHaveLength(9);
  });

  it("eviction only runs after closeCommand, not after openCommand or append", () => {
    const runtime = createCommandTrackingRuntime();
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION; i++) {
      openCommand(runtime, { id: `cmd-${i}`, now: i, cwd: null });
      closeCommand(runtime, { exitCode: 0, now: i + 1 });
    }
    // Open command 201 but don't close it — should still have 200 closed.
    openCommand(runtime, { id: "cmd-pending", now: 999, cwd: null });
    appendToCommandOutput(runtime, "in-flight data");
    expect(runtime.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    expect(runtime.inFlight?.id).toBe("cmd-pending");
  });
});

describe("TrackedCommand: lastCompleted", () => {
  it("returns null on an empty runtime", () => {
    const runtime = createCommandTrackingRuntime();
    expect(lastCompleted(runtime)).toBeNull();
  });

  it("returns the most-recently-closed command", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: "a", now: 100, cwd: null });
    closeCommand(runtime, { exitCode: 0, now: 200 });
    openCommand(runtime, { id: "b", now: 300, cwd: null });
    closeCommand(runtime, { exitCode: 1, now: 400 });
    expect(lastCompleted(runtime)?.id).toBe("b");
  });

  it("skips an in-flight command and returns the previous completed (spec scenario)", () => {
    const runtime = createCommandTrackingRuntime();
    openCommand(runtime, { id: "completed", now: 100, cwd: null });
    closeCommand(runtime, { exitCode: 0, now: 200 });
    openCommand(runtime, { id: "in-flight", now: 300, cwd: null });
    // Don't close — in-flight.
    expect(lastCompleted(runtime)?.id).toBe("completed");
  });
});

describe("TrackedCommand: spec scenarios", () => {
  it("Per-session eviction holds both caps simultaneously", () => {
    const runtime = createCommandTrackingRuntime();
    // Fill 200 entries each with ~5 KB output (well under 1 MB total).
    for (let i = 0; i < MAX_COMMANDS_PER_SESSION; i++) {
      openCommand(runtime, { id: `cmd-${i}`, now: i, cwd: null });
      appendToCommandOutput(runtime, "y".repeat(5000));
      closeCommand(runtime, { exitCode: 0, now: i + 1 });
    }
    expect(runtime.commands).toHaveLength(MAX_COMMANDS_PER_SESSION);
    // Verify the size invariant.
    const total = runtime.commands.reduce((acc, c) => acc + c.output.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_PER_SESSION);
    expect(total).toBe(200 * 5000);
  });
});
