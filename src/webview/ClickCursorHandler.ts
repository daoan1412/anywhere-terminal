// src/webview/ClickCursorHandler.ts — Plain-click terminal cursor movement

type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export interface ClickCursorTerminalLike {
  cols: number;
  rows: number;
  hasSelection(): boolean;
  buffer: {
    active: {
      type: "normal" | "alternate";
      cursorX: number;
      cursorY: number;
      viewportY: number;
      baseY: number;
    };
  };
  modes: {
    mouseTrackingMode: MouseTrackingMode;
  };
}

export interface ClickCursorHandlerDeps {
  container: HTMLElement;
  terminal: ClickCursorTerminalLike;
  sendInput: (data: string) => void;
}

export interface CellPosition {
  col: number;
  row: number;
}

interface CursorMoveParams {
  currentCol: number;
  currentRow: number;
  targetCol: number;
  targetRow: number;
  cols: number;
}

const CLICK_DRAG_THRESHOLD_PX = 4;
const LINK_CURSOR_CLASS = "xterm-cursor-pointer";

function isUnmodifiedPrimaryClick(event: MouseEvent): boolean {
  return (
    event.button === 0 && event.detail <= 1 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
}

function isClickGesture(start: CellPosition, end: CellPosition): boolean {
  return (
    Math.abs(start.col - end.col) <= CLICK_DRAG_THRESHOLD_PX && Math.abs(start.row - end.row) <= CLICK_DRAG_THRESHOLD_PX
  );
}

function isLinkClick(container: HTMLElement): boolean {
  return container.classList.contains(LINK_CURSOR_CLASS) || container.querySelector(`.${LINK_CURSOR_CLASS}`) !== null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getCellFromMouseEvent(
  event: MouseEvent,
  container: HTMLElement,
  terminal: Pick<ClickCursorTerminalLike, "cols" | "rows">,
): CellPosition | null {
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) {
    return null;
  }

  const cellWidth = rect.width / terminal.cols;
  const cellHeight = rect.height / terminal.rows;
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }

  return {
    col: clamp(Math.floor((event.clientX - rect.left) / cellWidth), 0, terminal.cols - 1),
    row: clamp(Math.floor((event.clientY - rect.top) / cellHeight), 0, terminal.rows - 1),
  };
}

export function createCursorMoveSequence(params: CursorMoveParams): string | null {
  const currentCol = clamp(params.currentCol, 0, params.cols);
  const currentRow = Math.max(params.currentRow, 0);
  const targetCol = clamp(params.targetCol, 0, params.cols - 1);
  const targetRow = Math.max(params.targetRow, 0);
  const currentOffset = currentRow * params.cols + currentCol;
  const targetOffset = targetRow * params.cols + targetCol;
  const delta = targetOffset - currentOffset;

  if (delta === 0) {
    return null;
  }

  const direction = delta > 0 ? "C" : "D";
  return `\x1b[${direction}`.repeat(Math.abs(delta));
}

export function canMoveCursorFromClick(terminal: ClickCursorTerminalLike): boolean {
  const buffer = terminal.buffer.active;
  return (
    buffer.type === "normal" &&
    buffer.viewportY === buffer.baseY &&
    terminal.modes.mouseTrackingMode === "none" &&
    !terminal.hasSelection()
  );
}

export function createClickCursorHandler(deps: ClickCursorHandlerDeps): void {
  let pointerDown: CellPosition | null = null;

  deps.container.addEventListener("mousedown", (event) => {
    if (!isUnmodifiedPrimaryClick(event)) {
      pointerDown = null;
      return;
    }
    pointerDown = { col: event.clientX, row: event.clientY };
  });

  deps.container.addEventListener("mouseup", (event) => {
    const start = pointerDown;
    pointerDown = null;

    if (
      !start ||
      !isUnmodifiedPrimaryClick(event) ||
      !isClickGesture(start, { col: event.clientX, row: event.clientY }) ||
      isLinkClick(deps.container)
    ) {
      return;
    }
    if (!canMoveCursorFromClick(deps.terminal)) {
      return;
    }

    const target = getCellFromMouseEvent(event, deps.container, deps.terminal);
    if (!target) {
      return;
    }

    const activeBuffer = deps.terminal.buffer.active;
    const sequence = createCursorMoveSequence({
      currentCol: activeBuffer.cursorX,
      currentRow: activeBuffer.cursorY,
      targetCol: target.col,
      targetRow: target.row,
      cols: deps.terminal.cols,
    });
    if (sequence) {
      deps.sendInput(sequence);
    }
  });
}
