import { describe, expect, it, vi } from "vitest";
import { handlePasteClipboardImage } from "./clipboardImageSync";
import { CTRL_V_PASTE } from "../shared/imagePasteTrigger";

describe("handlePasteClipboardImage", () => {
  it("always emits the PTY trigger after attempting OS clipboard sync", async () => {
    const writeToSession = vi.fn();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    await handlePasteClipboardImage(
      {
        tabId: "session-a",
        mimeType: "image/png",
        data: png.toString("base64"),
        trigger: CTRL_V_PASTE,
      },
      writeToSession,
    );

    expect(writeToSession).toHaveBeenCalledWith("session-a", CTRL_V_PASTE);
  });

  it("ignores invalid base64", async () => {
    const writeToSession = vi.fn();

    await handlePasteClipboardImage(
      {
        tabId: "session-a",
        mimeType: "image/png",
        data: "%%%not-base64%%%",
        trigger: CTRL_V_PASTE,
      },
      writeToSession,
    );

    expect(writeToSession).not.toHaveBeenCalled();
  });

  it("ignores empty fields", async () => {
    const writeToSession = vi.fn();

    await handlePasteClipboardImage(
      {
        tabId: "",
        mimeType: "image/png",
        data: "",
        trigger: CTRL_V_PASTE,
      },
      writeToSession,
    );

    expect(writeToSession).not.toHaveBeenCalled();
  });
});