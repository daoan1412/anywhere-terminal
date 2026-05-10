// @vitest-environment jsdom
// src/webview/ClickCursorHandler.test.ts — Unit tests for click-to-cursor behavior

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClickCursorTerminalLike,
  createClickCursorHandler,
  createCursorMoveSequence,
  getCellFromMouseEvent,
} from "./ClickCursorHandler";

function createTerminal(overrides: Partial<ClickCursorTerminalLike> = {}): ClickCursorTerminalLike {
  return {
    cols: 10,
    rows: 4,
    hasSelection: vi.fn(() => false),
    buffer: {
      active: {
        type: "normal",
        cursorX: 2,
        cursorY: 1,
        viewportY: 0,
        baseY: 0,
      },
    },
    modes: {
      mouseTrackingMode: "none",
    },
    ...overrides,
  };
}

function createContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(container, "getBoundingClientRect", {
    value: () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 40,
      right: 110,
      bottom: 60,
      x: 10,
      y: 20,
      toJSON: () => {},
    }),
  });
  return container;
}

function mouseEvent(type: string, overrides: MouseEventInit & { clientX?: number; clientY?: number } = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 35,
    clientY: 35,
    ...overrides,
  });
}

describe("getCellFromMouseEvent", () => {
  it("maps event coordinates to terminal cells", () => {
    const container = createContainer();
    const terminal = createTerminal();

    expect(getCellFromMouseEvent(mouseEvent("mouseup", { clientX: 35, clientY: 35 }), container, terminal)).toEqual({
      col: 2,
      row: 1,
    });
  });

  it("clamps coordinates to terminal bounds", () => {
    const container = createContainer();
    const terminal = createTerminal();

    expect(getCellFromMouseEvent(mouseEvent("mouseup", { clientX: 1000, clientY: 1000 }), container, terminal)).toEqual(
      {
        col: 9,
        row: 3,
      },
    );
  });

  it("returns null when container has no measurable size", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    });

    expect(getCellFromMouseEvent(mouseEvent("mouseup"), container, createTerminal())).toBeNull();
  });
});

describe("createCursorMoveSequence", () => {
  it("returns right movement for cells after the cursor", () => {
    expect(createCursorMoveSequence({ currentCol: 2, currentRow: 1, targetCol: 7, targetRow: 1, cols: 10 })).toBe(
      "\x1b[C\x1b[C\x1b[C\x1b[C\x1b[C",
    );
  });

  it("returns left movement for cells before the cursor", () => {
    expect(createCursorMoveSequence({ currentCol: 7, currentRow: 1, targetCol: 2, targetRow: 1, cols: 10 })).toBe(
      "\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D",
    );
  });

  it("uses linear cell distance across wrapped rows", () => {
    expect(createCursorMoveSequence({ currentCol: 8, currentRow: 1, targetCol: 2, targetRow: 2, cols: 10 })).toBe(
      "\x1b[C\x1b[C\x1b[C\x1b[C",
    );
  });

  it("returns null when target equals cursor", () => {
    expect(createCursorMoveSequence({ currentCol: 2, currentRow: 1, targetCol: 2, targetRow: 1, cols: 10 })).toBeNull();
  });

  it("supports a cursor after the last column", () => {
    expect(createCursorMoveSequence({ currentCol: 10, currentRow: 1, targetCol: 9, targetRow: 1, cols: 10 })).toBe(
      "\x1b[D",
    );
  });
});

describe("createClickCursorHandler", () => {
  let container: HTMLDivElement;
  let terminal: ClickCursorTerminalLike;
  let sendInput: (data: string) => void;

  beforeEach(() => {
    container = createContainer();
    terminal = createTerminal();
    sendInput = vi.fn();
    createClickCursorHandler({ container, terminal, sendInput });
  });

  it("sends relative movement on unmodified primary click", () => {
    container.dispatchEvent(mouseEvent("mousedown", { clientX: 75, clientY: 35 }));
    container.dispatchEvent(mouseEvent("mouseup", { clientX: 75, clientY: 35 }));

    expect(sendInput).toHaveBeenCalledWith("\x1b[C\x1b[C\x1b[C\x1b[C");
  });

  it("does not send input for modified clicks", () => {
    container.dispatchEvent(mouseEvent("mousedown", { altKey: true }));
    container.dispatchEvent(mouseEvent("mouseup", { altKey: true }));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input for non-primary clicks", () => {
    container.dispatchEvent(mouseEvent("mousedown", { button: 2 }));
    container.dispatchEvent(mouseEvent("mouseup", { button: 2 }));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input for double clicks", () => {
    container.dispatchEvent(mouseEvent("mousedown", { detail: 2 }));
    container.dispatchEvent(mouseEvent("mouseup", { detail: 2 }));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input when xterm is hovering a link", () => {
    container.classList.add("xterm-cursor-pointer");

    container.dispatchEvent(mouseEvent("mousedown"));
    container.dispatchEvent(mouseEvent("mouseup"));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input when a nested xterm element is hovering a link", () => {
    const xtermElement = document.createElement("div");
    xtermElement.classList.add("xterm", "xterm-cursor-pointer");
    container.appendChild(xtermElement);

    container.dispatchEvent(mouseEvent("mousedown"));
    container.dispatchEvent(mouseEvent("mouseup"));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input for drag gestures", () => {
    container.dispatchEvent(mouseEvent("mousedown", { clientX: 35, clientY: 35 }));
    container.dispatchEvent(mouseEvent("mouseup", { clientX: 60, clientY: 35 }));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input while text is selected", () => {
    vi.mocked(terminal.hasSelection).mockReturnValue(true);

    container.dispatchEvent(mouseEvent("mousedown"));
    container.dispatchEvent(mouseEvent("mouseup"));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input when viewport is scrolled back", () => {
    terminal.buffer.active.viewportY = 2;
    terminal.buffer.active.baseY = 5;

    container.dispatchEvent(mouseEvent("mousedown"));
    container.dispatchEvent(mouseEvent("mouseup"));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not send input in alternate buffer", () => {
    terminal.buffer.active.type = "alternate";

    container.dispatchEvent(mouseEvent("mousedown"));
    container.dispatchEvent(mouseEvent("mouseup"));

    expect(sendInput).not.toHaveBeenCalled();
  });

  it.each(["x10", "vt200", "drag", "any"] as const)("does not send input when mouse tracking is %s", (mode) => {
    terminal.modes.mouseTrackingMode = mode;

    container.dispatchEvent(mouseEvent("mousedown"));
    container.dispatchEvent(mouseEvent("mouseup"));

    expect(sendInput).not.toHaveBeenCalled();
  });
});
