// @vitest-environment jsdom
// src/webview/fileTree/FileTreeController.test.ts — Tests for the
// FileTreeController's git-status-changed dispatch (generation gate + revision
// passthrough to the data source via FileTreePanel).
//
// See: asimov/changes/add-file-tree-git-decorations/tasks.md task 4_3
//      asimov/changes/add-file-tree-git-decorations/specs/git-decoration-source/spec.md
//        #requirement-incremental-change-message

import { describe, expect, it, vi } from "vitest";
import type { GitStatusChangedMessage } from "../../types/messages";
import { FileTreeController } from "./FileTreeController";
import type { FileTreePanel } from "./FileTreePanel";

function makePanelStub(currentGen: number) {
  const handleGitStatusChanged = vi.fn();
  const panel = {
    getCurrentRootGeneration: () => currentGen,
    handleGitStatusChanged,
  } as unknown as FileTreePanel;
  return { panel, handleGitStatusChanged };
}

// Helper to bypass `mount()` (which requires DOM + store + post wiring) and
// construct a controller with a stub panel directly. We reach through the
// private constructor via `Object.create` + index-write — clearer than
// trying to widen the TypeScript surface for tests.
function makeController(panel: FileTreePanel): FileTreeController {
  const proto = (FileTreeController as unknown as { prototype: object }).prototype;
  const controller = Object.create(proto) as FileTreeController;
  const mutable = controller as unknown as Record<string, unknown>;
  mutable.panel = panel;
  mutable.lastWorkspaceRoot = null;
  mutable.deps = {};
  return controller;
}

describe("FileTreeController.handleGitStatusChanged", () => {
  it("forwards an in-generation message to the panel", () => {
    const { panel, handleGitStatusChanged } = makePanelStub(3);
    const controller = makeController(panel);
    const msg: GitStatusChangedMessage = {
      type: "git-status-changed",
      rootGeneration: 3,
      revision: 7,
      changes: [{ path: "/x", status: "modified" }],
    };
    controller.handleGitStatusChanged(msg);
    expect(handleGitStatusChanged).toHaveBeenCalledTimes(1);
    expect(handleGitStatusChanged).toHaveBeenCalledWith(7, [{ path: "/x", status: "modified" }]);
  });

  it("drops a message whose rootGeneration does not match the current panel state", () => {
    const { panel, handleGitStatusChanged } = makePanelStub(3);
    const controller = makeController(panel);
    controller.handleGitStatusChanged({
      type: "git-status-changed",
      rootGeneration: 2,
      revision: 7,
      changes: [{ path: "/x", status: "modified" }],
    });
    expect(handleGitStatusChanged).not.toHaveBeenCalled();
  });
});
