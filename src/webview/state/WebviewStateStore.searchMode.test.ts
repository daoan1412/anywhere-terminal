// src/webview/state/WebviewStateStore.searchMode.test.ts — Verify
// FileTreeState.searchMode is additive: legacy persisted state shapes load
// cleanly (the new field is undefined; consumers apply the `'filter'` default
// at read time), and writes round-trip through getState().
//
// See: asimov/changes/add-file-tree-search/specs/file-tree-panel/spec.md
//      "Mode toggle persists per webview session" + "State persistence schema"

import { describe, expect, it, vi } from "vitest";
import { WebviewStateStore } from "./WebviewStateStore";

function createMockVsCodeApi() {
  let storedState: unknown = null;
  return {
    getState: vi.fn(() => storedState),
    setState: vi.fn((state: unknown) => {
      storedState = state;
    }),
  };
}

describe("WebviewStateStore — FileTreeState.searchMode", () => {
  it("legacy fileTreeByLocation without searchMode loads cleanly (field is optional)", () => {
    const api = createMockVsCodeApi();
    api.setState({
      fileTreeByLocation: {
        sidebar: { open: true, position: "left", expandedPaths: [] },
      },
    });
    const store = new WebviewStateStore(api);
    const state = store.getState();
    expect(state.fileTreeByLocation?.sidebar?.searchMode).toBeUndefined();
    // Consumers apply `?? 'filter'` at read site — the SHAPE is additive.
    const resolved = state.fileTreeByLocation?.sidebar?.searchMode ?? "filter";
    expect(resolved).toBe("filter");
  });

  it("searchMode round-trips through updateState", () => {
    const api = createMockVsCodeApi();
    const store = new WebviewStateStore(api);
    store.updateState({
      fileTreeByLocation: {
        sidebar: { open: true, position: "left", expandedPaths: [], searchMode: "highlight" },
      },
    });
    const state = store.getState();
    expect(state.fileTreeByLocation?.sidebar?.searchMode).toBe("highlight");
  });

  it("searchMode is independent per location bucket", () => {
    const api = createMockVsCodeApi();
    const store = new WebviewStateStore(api);
    store.updateState({
      fileTreeByLocation: {
        sidebar: { open: true, position: "left", expandedPaths: [], searchMode: "filter" },
        panel: { open: true, position: "bottom", expandedPaths: [], searchMode: "highlight" },
      },
    });
    const state = store.getState();
    expect(state.fileTreeByLocation?.sidebar?.searchMode).toBe("filter");
    expect(state.fileTreeByLocation?.panel?.searchMode).toBe("highlight");
  });
});
