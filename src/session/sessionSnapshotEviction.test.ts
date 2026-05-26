import { describe, expect, it } from "vitest";
import type { SessionSnapshotMetadata, SessionSnapshotsIndex } from "./SessionSnapshot";
import {
  evictIndex,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MAX_BUFFER_BYTES,
  SNAPSHOT_MAX_COUNT,
} from "./sessionSnapshotEviction";

const NOW = 1_700_000_000_000;

function meta(sessionId: string, overrides: Partial<SessionSnapshotMetadata> = {}): SessionSnapshotMetadata {
  return {
    sessionId,
    viewLocation: "sidebar",
    terminalNumber: 1,
    customName: null,
    shell: "/bin/zsh",
    shellArgs: [],
    cwd: "/home/user",
    currentCwd: null,
    cols: 80,
    rows: 24,
    bufferFile: `snapshots/${sessionId}.snapshot.ans`,
    bufferBytes: 1024,
    isSplitPane: false,
    rootTabId: sessionId,
    snapshotAt: NOW - 1000,
    shellExited: false,
    exitCode: null,
    ...overrides,
  };
}

function indexOf(entries: SessionSnapshotMetadata[]): SessionSnapshotsIndex {
  return {
    version: 1,
    entries: Object.fromEntries(entries.map((e) => [e.sessionId, e])),
  };
}

describe("evictIndex", () => {
  it("drops entries strictly older than 7 days", () => {
    const justInside = meta("inside", { snapshotAt: NOW - (SNAPSHOT_MAX_AGE_MS - 1) });
    const exactlyAtBoundary = meta("boundary", { snapshotAt: NOW - SNAPSHOT_MAX_AGE_MS });
    const wayOld = meta("old", { snapshotAt: NOW - (SNAPSHOT_MAX_AGE_MS + 60_000) });

    const result = evictIndex(indexOf([justInside, exactlyAtBoundary, wayOld]), NOW);
    expect(Object.keys(result.kept.entries).sort()).toEqual(["inside"]);
    expect(result.dropped.sort()).toEqual(["boundary", "old"]);
  });

  it("drops entries with bufferBytes above the 1MB cap", () => {
    const ok = meta("ok", { bufferBytes: SNAPSHOT_MAX_BUFFER_BYTES });
    const tooBig = meta("big", { bufferBytes: SNAPSHOT_MAX_BUFFER_BYTES + 1 });
    const result = evictIndex(indexOf([ok, tooBig]), NOW);
    expect(Object.keys(result.kept.entries)).toEqual(["ok"]);
    expect(result.dropped).toEqual(["big"]);
  });

  it("keeps only the 20 most recent entries when count exceeds the cap", () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      meta(`s${i.toString().padStart(2, "0")}`, { snapshotAt: NOW - 1000 - (24 - i) * 1000 }),
    );
    const result = evictIndex(indexOf(entries), NOW);
    expect(Object.keys(result.kept.entries)).toHaveLength(SNAPSHOT_MAX_COUNT);

    const keptIds = new Set(Object.keys(result.kept.entries));
    // Most recent = s24, s23, ..., s05. s00..s04 should be dropped.
    for (let i = 5; i < 25; i++) {
      expect(keptIds.has(`s${i.toString().padStart(2, "0")}`)).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      expect(keptIds.has(`s${i.toString().padStart(2, "0")}`)).toBe(false);
    }
    expect(result.dropped.sort()).toEqual(
      Array.from({ length: 5 }, (_, i) => `s${i.toString().padStart(2, "0")}`).sort(),
    );
  });

  it("composes age + size + count caps in order", () => {
    const entries = [
      meta("recent_small", { snapshotAt: NOW - 1000, bufferBytes: 1024 }),
      meta("recent_huge", { snapshotAt: NOW - 1000, bufferBytes: SNAPSHOT_MAX_BUFFER_BYTES + 1 }),
      meta("ancient", { snapshotAt: NOW - SNAPSHOT_MAX_AGE_MS - 1, bufferBytes: 1024 }),
    ];
    const result = evictIndex(indexOf(entries), NOW);
    expect(Object.keys(result.kept.entries)).toEqual(["recent_small"]);
    expect(result.dropped.sort()).toEqual(["ancient", "recent_huge"]);
  });

  it("orders survivors by snapshotAt descending (stable on tie)", () => {
    const entries = [
      meta("a", { snapshotAt: NOW - 3000 }),
      meta("b", { snapshotAt: NOW - 1000 }),
      meta("c", { snapshotAt: NOW - 2000 }),
    ];
    const result = evictIndex(indexOf(entries), NOW);
    // All three survive; check kept set rather than ordering of dict entries.
    expect(new Set(Object.keys(result.kept.entries))).toEqual(new Set(["a", "b", "c"]));
    expect(result.dropped).toEqual([]);
  });

  it("returns an empty kept index when input is empty", () => {
    const result = evictIndex({ version: 1, entries: {} }, NOW);
    expect(result.kept).toEqual({ version: 1, entries: {} });
    expect(result.dropped).toEqual([]);
  });

  it("keeps split-pane groups atomically — a tab and its children evict together", () => {
    // 7 roots × 3 panes = 21 entries; the 20-cap forces dropping the OLDEST root
    // group whole rather than slicing a partial group (which would orphan the
    // webview's layout). See round-1 B4.
    const entries: SessionSnapshotMetadata[] = [];
    for (let r = 0; r < 7; r++) {
      const rootId = `root-${r}`;
      const baseAt = NOW - 1000 - (6 - r) * 10_000; // root-0 oldest, root-6 newest
      entries.push(meta(rootId, { snapshotAt: baseAt, isSplitPane: false, rootTabId: rootId }));
      entries.push(
        meta(`${rootId}-p1`, { snapshotAt: baseAt + 100, isSplitPane: true, rootTabId: rootId }),
      );
      entries.push(
        meta(`${rootId}-p2`, { snapshotAt: baseAt + 200, isSplitPane: true, rootTabId: rootId }),
      );
    }
    const result = evictIndex(indexOf(entries), NOW);
    const keptIds = new Set(Object.keys(result.kept.entries));
    // The OLDEST root (root-0) group must be dropped whole.
    expect(keptIds.has("root-0")).toBe(false);
    expect(keptIds.has("root-0-p1")).toBe(false);
    expect(keptIds.has("root-0-p2")).toBe(false);
    // All 6 newer roots survive in full.
    for (let r = 1; r < 7; r++) {
      expect(keptIds.has(`root-${r}`)).toBe(true);
      expect(keptIds.has(`root-${r}-p1`)).toBe(true);
      expect(keptIds.has(`root-${r}-p2`)).toBe(true);
    }
    expect(result.dropped.sort()).toEqual(["root-0", "root-0-p1", "root-0-p2"].sort());
  });

  it("groups age check uses max(snapshotAt) — a dormant split child survives while sibling is fresh", () => {
    // root-X has one stale child (older than the 7d cap on its own) and one
    // fresh sibling. Pre-W1 logic would drop the stale child first (per-entry
    // age), orphaning the group. Post-W1 the group's max(snapshotAt) is used,
    // and since the sibling is fresh the WHOLE group survives.
    const stale = meta("root-X-p1", {
      snapshotAt: NOW - SNAPSHOT_MAX_AGE_MS - 60_000,
      isSplitPane: true,
      rootTabId: "root-X",
    });
    const fresh = meta("root-X", {
      snapshotAt: NOW - 1000,
      isSplitPane: false,
      rootTabId: "root-X",
    });
    const result = evictIndex(indexOf([stale, fresh]), NOW);
    expect(new Set(Object.keys(result.kept.entries))).toEqual(new Set(["root-X-p1", "root-X"]));
    expect(result.dropped).toEqual([]);
  });

  it("groups size check drops the WHOLE group if any member is oversized", () => {
    // truncateSnapshotBuffer caps writes at 1 MB, so an oversized entry is
    // a corrupted-state safety signal. Round-2 W1: dropping just the oversized
    // pane while keeping its sibling would orphan the layout — drop together.
    const okPane = meta("root-Y", { isSplitPane: false, rootTabId: "root-Y" });
    const oversizedPane = meta("root-Y-p1", {
      bufferBytes: SNAPSHOT_MAX_BUFFER_BYTES + 1,
      isSplitPane: true,
      rootTabId: "root-Y",
    });
    const result = evictIndex(indexOf([okPane, oversizedPane]), NOW);
    expect(Object.keys(result.kept.entries)).toEqual([]);
    expect(result.dropped.sort()).toEqual(["root-Y", "root-Y-p1"].sort());
  });

  it("admits groups in newest-first order using each group's max snapshotAt", () => {
    // Root A's freshest pane is 10ms newer than Root B's freshest. With a count
    // cap of 4 and two groups of 2 panes each, both groups fit (4 entries) —
    // verifying the group sort doesn't accidentally pick the wrong ordering.
    const entries = [
      meta("A", { snapshotAt: NOW - 3000, isSplitPane: false, rootTabId: "A" }),
      meta("A-p1", { snapshotAt: NOW - 1000, isSplitPane: true, rootTabId: "A" }), // newest in A
      meta("B", { snapshotAt: NOW - 2500, isSplitPane: false, rootTabId: "B" }),
      meta("B-p1", { snapshotAt: NOW - 1500, isSplitPane: true, rootTabId: "B" }),
    ];
    const result = evictIndex(indexOf(entries), NOW);
    expect(new Set(Object.keys(result.kept.entries))).toEqual(new Set(["A", "A-p1", "B", "B-p1"]));
    expect(result.dropped).toEqual([]);
  });
});
