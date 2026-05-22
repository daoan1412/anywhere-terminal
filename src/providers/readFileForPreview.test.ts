// src/providers/readFileForPreview.test.ts — Two-tier cap + binary heuristic +
// UTF-8 boundary safety + cancellation. See: design.md D6.

import { describe, expect, it, vi } from "vitest";
import {
  BINARY_SCAN_BYTES,
  HARD_LIMIT_BYTES,
  MAX_LINES,
  PREVIEW_LIMIT_BYTES,
  type ReadFileForPreviewFs,
  readFileForPreview,
} from "./readFileForPreview";

function makeFakeUri(): { fsPath: string } {
  return { fsPath: "/mock/file" };
}

function makeFakeToken(cancelled = false) {
  return { isCancellationRequested: cancelled, onCancellationRequested: () => ({ dispose() {} }) };
}

function makeFs(
  overrides: Partial<{ stat: ReadFileForPreviewFs["stat"]; readFile: ReadFileForPreviewFs["readFile"] }> = {},
): ReadFileForPreviewFs {
  return {
    stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 })),
    readFile: vi.fn(async () => new Uint8Array()),
    ...overrides,
  } as ReadFileForPreviewFs;
}

describe("readFileForPreview", () => {
  it("returns too-large WITHOUT calling readFile when stat.size > HARD_LIMIT", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("readFile must not be called");
    });
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: HARD_LIMIT_BYTES + 1 })),
      readFile: readFile as ReadFileForPreviewFs["readFile"],
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result).toEqual({ status: "too-large", totalBytes: HARD_LIMIT_BYTES + 1 });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("uses readBytes (bounded) when wired — defeats TOCTOU memory blow-up (round-2 W1)", async () => {
    // Round-2 W1: with `readBytes` wired, the reader caps the buffer at
    // HARD_LIMIT + 1. A symlink swap mid-read can't push more than that into
    // memory. The legacy `readFile` is NOT called when `readBytes` is present.
    const readFile = vi.fn(async () => {
      throw new Error("readFile must not be called when readBytes is wired");
    });
    // readBytes simulates the bounded read returning HARD_LIMIT + 1 bytes,
    // indicating the file exceeds the cap (truncated at the requested limit).
    const oversizeSlice = new Uint8Array(HARD_LIMIT_BYTES + 1).fill(0x61);
    const readBytes = vi.fn(async () => oversizeSlice);
    const fs = {
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 1024 })), // stat lies — claims small
      readFile,
      readBytes,
    } as ReadFileForPreviewFs;

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result).toEqual({ status: "too-large", totalBytes: HARD_LIMIT_BYTES + 1 });
    expect(readFile).not.toHaveBeenCalled();
    expect(readBytes).toHaveBeenCalledWith(expect.anything(), HARD_LIMIT_BYTES + 1);
  });

  it("returns too-large when readFile yields more bytes than HARD_LIMIT despite stat lying (TOCTOU defense)", async () => {
    // Simulate a symlink swap or race where stat() reports a small file but
    // readFile() resolves to a much larger buffer (e.g. swap to /dev/zero).
    const lyingSize = 1024;
    const actualBuf = new Uint8Array(HARD_LIMIT_BYTES + 100).fill(0x61);
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: lyingSize })),
      readFile: vi.fn(async () => actualBuf),
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result).toEqual({ status: "too-large", totalBytes: actualBuf.byteLength });
  });

  it("sets truncated when the file exceeds PREVIEW_LIMIT but stays under HARD_LIMIT", async () => {
    const size = HARD_LIMIT_BYTES - 1;
    // Build a buffer of 600 KB filled with `a` (every byte == 0x61, no NUL).
    const buf = new Uint8Array(size).fill(0x61);
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size })),
      readFile: vi.fn(async () => buf),
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(size);
    // Content is the first PREVIEW_LIMIT bytes as text (single line of `a`s).
    expect((result as { content?: string }).content?.length).toBe(PREVIEW_LIMIT_BYTES);
  });

  it("truncates by line count when the file has > MAX_LINES lines", async () => {
    const lines = Array.from({ length: MAX_LINES + 100 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const buf = new TextEncoder().encode(text);
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(MAX_LINES + 100);
    // content lines must be exactly MAX_LINES, last line is the MAX_LINES-th input line.
    const content = (result as { content?: string }).content ?? "";
    const contentLines = content.split("\n");
    expect(contentLines).toHaveLength(MAX_LINES);
    expect(contentLines[MAX_LINES - 1]).toBe(`line ${MAX_LINES}`);
  });

  it("returns binary when a NUL byte is in the first 8 KB", async () => {
    const buf = new Uint8Array(16_000).fill(0x41);
    buf[BINARY_SCAN_BYTES - 1] = 0x00; // last byte of the scan window
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result.status).toBe("binary");
    if (result.status !== "binary") {
      throw new Error("expected binary");
    }
    expect(result.totalBytes).toBe(16_000);
    expect((result as { content?: string }).content).toBeUndefined();
  });

  it("does NOT mark binary when the NUL byte is past the scan window", async () => {
    const buf = new Uint8Array(16_000).fill(0x41);
    buf[BINARY_SCAN_BYTES + 10] = 0x00; // past the scan window
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result.status).toBe("ok");
    // The NUL becomes a replacement char in the decoded string — content is still present.
    expect((result as { content?: string }).content).toBeDefined();
  });

  it("handles a UTF-8 multi-byte sequence straddling the PREVIEW_LIMIT boundary without throwing", async () => {
    // Construct a buffer of length PREVIEW_LIMIT + 4, with a 3-byte UTF-8
    // sequence (e.g. €, 0xE2 0x82 0xAC) starting at PREVIEW_LIMIT - 1 so the
    // slice cuts it mid-sequence.
    const totalLen = PREVIEW_LIMIT_BYTES + 4;
    const buf = new Uint8Array(totalLen).fill(0x61);
    buf[PREVIEW_LIMIT_BYTES - 1] = 0xe2;
    buf[PREVIEW_LIMIT_BYTES] = 0x82;
    buf[PREVIEW_LIMIT_BYTES + 1] = 0xac;
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: totalLen })),
      readFile: vi.fn(async () => buf),
    });

    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.truncated).toBe(true);
    // With fatal=false, the trailing 0xE2 becomes a U+FFFD replacement char.
    expect(result.content).toContain("�");
  });

  it("returns cancelled when the token is already cancelled before stat", async () => {
    const fs = makeFs();
    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken(true) as never);
    expect(result).toEqual({ status: "cancelled" });
    expect(fs.stat).not.toHaveBeenCalled();
  });

  it("returns cancelled when the token is cancelled between stat and readFile", async () => {
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const fs = makeFs({
      stat: vi.fn(async () => {
        token.isCancellationRequested = true;
        return { type: 1, ctime: 0, mtime: 0, size: 100 };
      }),
    });
    const result = await readFileForPreview(makeFakeUri() as never, fs, token as never);
    expect(result.status).toBe("cancelled");
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("returns error when stat throws (e.g. file not found)", async () => {
    const fs = makeFs({
      stat: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });
    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);
    expect(result.status).toBe("error");
  });

  it("returns error when readFile throws but stat succeeded", async () => {
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 100 })),
      readFile: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);
    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected error");
    }
    expect(result.totalBytes).toBe(100);
  });

  it("returns ok with content for a small text file", async () => {
    const text = "hello\nworld";
    const buf = new TextEncoder().encode(text);
    const fs = makeFs({
      stat: vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: buf.byteLength })),
      readFile: vi.fn(async () => buf),
    });
    const result = await readFileForPreview(makeFakeUri() as never, fs, makeFakeToken() as never);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected ok");
    }
    expect(result.content).toBe("hello\nworld");
    expect(result.truncated).toBeUndefined();
    expect(result.totalLines).toBe(2);
  });
});
