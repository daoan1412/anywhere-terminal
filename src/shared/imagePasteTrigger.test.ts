import { describe, expect, it } from "vitest";
import { BRACKETED_EMPTY_PASTE, CTRL_V_PASTE, getImagePastePtyTrigger } from "./imagePasteTrigger";

describe("getImagePastePtyTrigger", () => {
  it("sends Ctrl+V on non-macOS", () => {
    expect(getImagePastePtyTrigger(false)).toBe(CTRL_V_PASTE);
    expect(CTRL_V_PASTE).toBe("\x16");
  });

  it("sends empty bracketed paste on macOS", () => {
    expect(getImagePastePtyTrigger(true)).toBe(BRACKETED_EMPTY_PASTE);
    expect(BRACKETED_EMPTY_PASTE).toBe("\x1b[200~\x1b[201~");
  });
});