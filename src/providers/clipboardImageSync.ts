// Extension-host: mirror a pasted image into the OS clipboard so PTY children
// (Claude Code, Codex, Grok) can read it via arboard/xclip/wl-paste.

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function fileExtensionForMime(mimeType: string): string {
  if (mimeType.includes("png")) {
    return "png";
  }
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpg";
  }
  if (mimeType.includes("gif")) {
    return "gif";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  return "img";
}

function writeWlCopy(mimeType: string, data: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("wl-copy", ["--type", mimeType], { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    proc.stdin.write(data);
    proc.stdin.end();
  });
}

async function writeLinuxClipboard(mimeType: string, data: Buffer, tmpPath: string): Promise<boolean> {
  await fs.writeFile(tmpPath, data);

  if (process.env.WAYLAND_DISPLAY) {
    if (await writeWlCopy(mimeType, data)) {
      return true;
    }
  }

  if (process.env.DISPLAY) {
    try {
      await execFileAsync("xclip", ["-selection", "clipboard", "-t", mimeType, "-i", tmpPath]);
      return true;
    } catch {
      // xclip not installed or selection busy.
    }
  }

  return false;
}

async function writeDarwinClipboard(tmpPath: string): Promise<boolean> {
  try {
    await execFileAsync("osascript", [
      "-e",
      `set the clipboard to (read (POSIX file "${tmpPath}") as «class PNGf»)`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function writeWindowsClipboard(tmpPath: string): Promise<boolean> {
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$img = [System.Drawing.Image]::FromFile($env:AWT_CLIP_PATH)",
    "[System.Windows.Forms.Clipboard]::SetImage($img)",
    "$img.Dispose()",
  ].join("; ");
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { env: { ...process.env, AWT_CLIP_PATH: tmpPath } },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Write image bytes to the OS clipboard. Returns false when no supported tool
 * is available — callers should still send the PTY paste trigger (the image may
 * already be on the clipboard from an external copy).
 */
export async function writeImageToOsClipboard(mimeType: string, data: Buffer): Promise<boolean> {
  if (data.length === 0) {
    return false;
  }

  const normalizedMime = mimeType.trim() || "image/png";
  const tmpPath = path.join(
    os.tmpdir(),
    `awt-clipboard-${process.pid}-${Date.now()}.${fileExtensionForMime(normalizedMime)}`,
  );

  try {
    switch (process.platform) {
      case "linux":
        return writeLinuxClipboard(normalizedMime, data, tmpPath);
      case "darwin":
        await fs.writeFile(tmpPath, data);
        return writeDarwinClipboard(tmpPath);
      case "win32":
        await fs.writeFile(tmpPath, data);
        return writeWindowsClipboard(tmpPath);
      default:
        return false;
    }
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}

export interface PasteClipboardImagePayload {
  tabId: string;
  mimeType: string;
  data: string;
  trigger: string;
}

/**
 * Mirror a webview-captured image to the OS clipboard, then emit the PTY paste
 * trigger so Claude Code / Codex / Grok read it via arboard.
 */
export async function handlePasteClipboardImage(
  payload: PasteClipboardImagePayload,
  writeToSession: (tabId: string, data: string) => void,
): Promise<void> {
  const { tabId, data, trigger } = payload;
  if (!tabId || !data || !trigger) {
    return;
  }

  const trimmed = data.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
    return;
  }

  const buffer = Buffer.from(trimmed, "base64");
  if (buffer.length === 0) {
    return;
  }

  const mimeType = payload.mimeType?.trim() || "image/png";
  await writeImageToOsClipboard(mimeType, buffer);
  writeToSession(tabId, trigger);
}