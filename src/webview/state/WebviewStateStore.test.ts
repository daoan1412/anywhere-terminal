// src/webview/state/WebviewStateStore.test.ts — Unit tests for WebviewStateStore

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBranch, createLeaf } from "../SplitModel";
import { WebviewStateStore } from "./WebviewStateStore";

// ─── Helpers ────────────────────────────────────────────────────────

function createMockVsCodeApi() {
  let storedState: unknown = null;
  return {
    getState: vi.fn(() => storedState),
    setState: vi.fn((state: unknown) => {
      storedState = state;
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("WebviewStateStore", () => {
  let api: ReturnType<typeof createMockVsCodeApi>;
  let store: WebviewStateStore;

  beforeEach(() => {
    api = createMockVsCodeApi();
    store = new WebviewStateStore(api);
  });

  it("has correct initial state defaults", () => {
    expect(store.activeTabId).toBeNull();
    expect(store.terminals.size).toBe(0);
    expect(store.tabLayouts.size).toBe(0);
    expect(store.tabActivePaneIds.size).toBe(0);
    expect(store.resizeCleanups.size).toBe(0);
    expect(store.currentConfig).toEqual({
      fontSize: 14,
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: "",
    });
  });

  it("setActiveTab updates activeTabId", () => {
    store.setActiveTab("tab-1");
    expect(store.activeTabId).toBe("tab-1");

    store.setActiveTab(null);
    expect(store.activeTabId).toBeNull();
  });

  it("setLayout and deleteLayout manage tabLayouts", () => {
    const layout = createLeaf("session-1");
    store.setLayout("tab-1", layout);
    expect(store.tabLayouts.get("tab-1")).toBe(layout);

    store.deleteLayout("tab-1");
    expect(store.tabLayouts.has("tab-1")).toBe(false);
  });

  it("setActivePaneId and getActivePaneId manage pane tracking", () => {
    store.setActivePaneId("tab-1", "pane-a");
    expect(store.getActivePaneId("tab-1")).toBe("pane-a");
  });

  it("getActivePaneId falls back to tabId when no pane is set", () => {
    expect(store.getActivePaneId("tab-1")).toBe("tab-1");
  });

  it("persist serializes tabLayouts and tabActivePaneIds to vscode state", () => {
    const layout = createBranch("vertical", createLeaf("s1"), createLeaf("s2"));
    store.setLayout("tab-1", layout);
    store.setActivePaneId("tab-1", "s2");

    store.persist();

    expect(api.setState).toHaveBeenCalledTimes(1);
    const saved = api.setState.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.tabLayouts).toEqual({ "tab-1": layout });
    expect(saved.tabActivePaneIds).toEqual({ "tab-1": "s2" });
  });

  it("restore recovers valid state and validates pane IDs against layout", () => {
    // Seed the api with valid persisted state
    const layout = createBranch("vertical", createLeaf("s1"), createLeaf("s2"));
    api.setState({
      tabLayouts: { "tab-1": layout },
      tabActivePaneIds: { "tab-1": "s2" },
    });

    const restored = store.restore();

    expect(restored.size).toBe(1);
    expect(restored.get("tab-1")).toEqual(layout);
    expect(store.getActivePaneId("tab-1")).toBe("s2");
  });

  it("restore returns empty map for null or malformed state", () => {
    // null state
    api.getState.mockReturnValue(null);
    expect(store.restore().size).toBe(0);

    // malformed state — tabLayouts is not an object
    api.getState.mockReturnValue({ tabLayouts: "invalid" });
    expect(store.restore().size).toBe(0);

    // layout missing 'type' property
    api.getState.mockReturnValue({ tabLayouts: { t1: { noType: true } } });
    expect(store.restore().size).toBe(0);
  });

  it("restore rejects pane IDs that no longer exist in the layout", () => {
    const layout = createBranch("vertical", createLeaf("s1"), createLeaf("s2"));
    api.setState({
      tabLayouts: { "tab-1": layout },
      tabActivePaneIds: { "tab-1": "deleted-pane" },
    });

    store.restore();

    // Pane ID "deleted-pane" is not in the layout, so it should fall back to tabId
    expect(store.getActivePaneId("tab-1")).toBe("tab-1");
  });

  // ── Typed WebviewState + fileTree persistence (port-vscode-async-data-tree task 4_5) ──

  it("legacy fileTree slot is migrated into fileTreeByLocation.sidebar on first read", () => {
    // Simulate a state blob written before per-location bucketing was added.
    api.setState({
      fileTree: { open: true, position: "left", expandedPaths: ["/repo", "/repo/src"] },
    });

    const restored = store.getState();
    expect(restored.fileTree).toBeUndefined();
    expect(restored.fileTreeByLocation).toEqual({
      sidebar: { open: true, position: "left", expandedPaths: ["/repo", "/repo/src"] },
    });
    // Migration is persisted so a second read sees the new shape directly.
    const second = store.getState();
    expect(second.fileTree).toBeUndefined();
    expect(second.fileTreeByLocation?.sidebar?.position).toBe("left");
  });

  it("migration preserves existing sidebar bucket (new shape wins over legacy slot)", () => {
    // Both slots populated — the new shape takes priority; legacy is dropped.
    api.setState({
      fileTree: { open: true, position: "left", expandedPaths: ["/old"] },
      fileTreeByLocation: {
        sidebar: { open: false, position: "right", expandedPaths: ["/new"] },
      },
    });

    const restored = store.getState();
    expect(restored.fileTree).toBeUndefined();
    expect(restored.fileTreeByLocation?.sidebar?.position).toBe("right");
    expect(restored.fileTreeByLocation?.sidebar?.expandedPaths).toEqual(["/new"]);
  });

  it("getState returns {} (no throw) when persisted state lacks both fileTree slots", () => {
    const layout = createBranch("vertical", createLeaf("s1"), createLeaf("s2"));
    api.setState({
      tabLayouts: { "tab-1": layout },
      tabActivePaneIds: { "tab-1": "s2" },
    });

    const restored = store.getState();
    expect(restored.fileTree).toBeUndefined();
    expect(restored.fileTreeByLocation).toBeUndefined();
    expect(restored.tabLayouts).toEqual({ "tab-1": layout });
  });

  it("updateState({fileTreeByLocation}) preserves unrelated top-level keys (additive schema)", () => {
    const layout = createBranch("vertical", createLeaf("s1"), createLeaf("s2"));
    store.setLayout("tab-1", layout);
    store.persist();

    store.updateState({
      fileTreeByLocation: {
        sidebar: { open: false, position: "bottom", expandedPaths: [] },
      },
    });

    const restored = store.getState();
    expect(restored.tabLayouts).toEqual({ "tab-1": layout });
    expect(restored.fileTreeByLocation?.sidebar).toEqual({
      open: false,
      position: "bottom",
      expandedPaths: [],
    });
  });
});
