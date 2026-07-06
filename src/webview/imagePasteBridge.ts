// Webview helpers for AI-CLI image paste (Claude Code, Codex, Grok).
// CLIs read images from the OS clipboard out-of-band; the webview must (1) cache
// the blob for hover preview and (2) ask the extension host to sync it to the OS
// clipboard, then forward the paste trigger bytes to the PTY.

import { getImagePastePtyTrigger } from "../shared/imagePasteTrigger";
import type { PasteClipboardImageMessage } from "../types/messages";

export { getImagePastePtyTrigger };

/** First image/* item from a paste event, if any. */
export function extractImageBlobFromClipboardItems(items: DataTransferItemList): File | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

/** Whether the key event is the platform paste shortcut (Cmd+V / Ctrl+V). */
export function isPasteShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  if (event.type !== "keydown" || event.altKey || event.shiftKey) {
    return false;
  }
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  return modifier && event.key.toLowerCase() === "v";
}

/** Encode a Blob as base64 for the extension-host clipboard sync RPC. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export type { PasteClipboardImageMessage };

/**
 * Cache the image for hover preview and ask the extension host to mirror it to
 * the OS clipboard, then emit the PTY paste trigger for the active pane.
 */
export async function forwardImagePaste(
  blob: File,
  tabId: string,
  isMac: boolean,
  postMessage: (msg: PasteClipboardImageMessage) => void,
): Promise<void> {
  const data = await blobToBase64(blob);
  postMessage({
    type: "pasteClipboardImage",
    tabId,
    mimeType: blob.type || "image/png",
    data,
    trigger: getImagePastePtyTrigger(isMac),
  });
}

/** Dedup window so keydown async probe + paste handler don't double-fire. */
export class ImagePasteDeduper {
  private handled = false;

  markHandled(): void {
    this.handled = true;
  }

  wasHandled(): boolean {
    return this.handled;
  }

  reset(): void {
    this.handled = false;
  }
}

/**
 * Fallback when the paste event never fires: probe navigator.clipboard for an
 * image item after the paste shortcut keydown.
 */
export async function probeClipboardForImageBlob(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) {
    return null;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith("image/"));
      if (imageType) {
        return item.getType(imageType);
      }
    }
  } catch {
    // Permission denied or unsupported in this webview context.
  }
  return null;
}