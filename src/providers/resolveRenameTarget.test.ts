// src/providers/resolveRenameTarget.test.ts — Unit tests for the rename
// command's target-resolution chain. See add-tab-rename design.md D5.

import { describe, expect, it, vi } from "vitest";
import { resolveRenameTargetTabId } from "./resolveRenameTarget";

describe("resolveRenameTargetTabId", () => {
  it("returns arg.tabId when provided (context-menu path)", () => {
    const getEditor = vi.fn();
    const getView = vi.fn();
    const result = resolveRenameTargetTabId({ tabId: "abc" }, getEditor, getView);
    expect(result).toBe("abc");
    expect(getEditor).not.toHaveBeenCalled();
    expect(getView).not.toHaveBeenCalled();
  });

  it("ignores an empty-string arg.tabId and falls through to provider chain", () => {
    const getEditor = vi.fn(() => ({ getActiveTabId: () => "ed-1" }));
    const getView = vi.fn();
    const result = resolveRenameTargetTabId({ tabId: "" }, getEditor, getView);
    expect(result).toBe("ed-1");
  });

  it("falls back to active editor provider when no arg", () => {
    const editor = { getActiveTabId: vi.fn(() => "ed-1") };
    const getView = vi.fn();
    const result = resolveRenameTargetTabId(undefined, () => editor, getView);
    expect(result).toBe("ed-1");
    expect(editor.getActiveTabId).toHaveBeenCalledTimes(1);
    expect(getView).not.toHaveBeenCalled();
  });

  it("falls back to focused view provider when editor returns undefined tab id", () => {
    const editor = { getActiveTabId: vi.fn(() => undefined) };
    const view = { getActiveTabId: vi.fn(() => "tab-1") };
    const result = resolveRenameTargetTabId(
      undefined,
      () => editor,
      () => view,
    );
    expect(result).toBe("tab-1");
    expect(editor.getActiveTabId).toHaveBeenCalledTimes(1);
    expect(view.getActiveTabId).toHaveBeenCalledTimes(1);
  });

  it("falls back to focused view provider when no editor is active", () => {
    const view = { getActiveTabId: vi.fn(() => "tab-1") };
    const result = resolveRenameTargetTabId(
      undefined,
      () => undefined,
      () => view,
    );
    expect(result).toBe("tab-1");
  });

  it("returns undefined when nothing is focused (silent no-op)", () => {
    const result = resolveRenameTargetTabId(
      undefined,
      () => undefined,
      () => undefined,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when both providers return undefined tab id", () => {
    const editor = { getActiveTabId: vi.fn(() => undefined) };
    const view = { getActiveTabId: vi.fn(() => undefined) };
    const result = resolveRenameTargetTabId(
      undefined,
      () => editor,
      () => view,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when arg has no tabId field", () => {
    const result = resolveRenameTargetTabId(
      {},
      () => undefined,
      () => undefined,
    );
    expect(result).toBeUndefined();
  });
});
