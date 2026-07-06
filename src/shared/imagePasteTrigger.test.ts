import { describe, expect, it } from "vitest";
import { BRACKETED_EMPTY_PASTE, CTRL_V_PASTE, getImagePastePtyTrigger } from "./imagePasteTrigger";

describe("getImagePastePtyTrigger", () => {
  it("always sends Ctrl+V for Codex/OpenCode/Grok, regardless of OS", () => {
    for (const kind of ["codex", "opencode", "grok"]) {
      expect(getImagePastePtyTrigger(kind, true)).toBe(CTRL_V_PASTE);
      expect(getImagePastePtyTrigger(kind, false)).toBe(CTRL_V_PASTE);
    }
    expect(CTRL_V_PASTE).toBe("\x16");
  });

  it("uses the OS-native signal for Claude and unknown/shell sessions", () => {
    expect(getImagePastePtyTrigger("claude", true)).toBe(BRACKETED_EMPTY_PASTE);
    expect(getImagePastePtyTrigger("claude", false)).toBe(CTRL_V_PASTE);
    expect(getImagePastePtyTrigger(undefined, true)).toBe(BRACKETED_EMPTY_PASTE);
    expect(getImagePastePtyTrigger(undefined, false)).toBe(CTRL_V_PASTE);
    expect(BRACKETED_EMPTY_PASTE).toBe("\x1b[200~\x1b[201~");
  });
});
