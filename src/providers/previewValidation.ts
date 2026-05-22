// src/providers/previewValidation.ts — IPC payload guards for hover-preview requests.
//
// Centralizes the length caps and NUL-byte rejection so both providers
// (`TerminalViewProvider`, `TerminalEditorProvider`) apply the same gate.
//
// See: asimov/changes/add-hover-file-preview/.reviews/round-1.md W3

/** Maximum length of `path` in a RequestFilePreviewMessage. PATH_MAX-ish. */
export const MAX_PREVIEW_PATH_LENGTH = 4096;
/** Maximum length of `requestId` / `sessionId` strings. */
export const MAX_ID_LENGTH = 128;

/** Shape that's loose enough to accept the raw discriminated-union variant from messages.ts. */
export interface MaybePreviewRequest {
  path?: unknown;
  sessionId?: unknown;
  requestId?: unknown;
  override?: unknown;
}

/**
 * True when the payload passes the IPC-layer guards. Defense-in-depth: even
 * though the webview is same-origin and trusted, a buggy/compromised webview
 * shouldn't be able to drive arbitrary host-side work.
 *
 * Rejects (silently — caller drops the request):
 * - non-string `path` / `sessionId` / `requestId`
 * - empty `path`
 * - `path.length > 4096` (PATH_MAX-ish)
 * - `path` contains NUL byte
 * - `sessionId.length > 128` or `requestId.length > 128`
 */
export function isValidPreviewRequest(msg: MaybePreviewRequest): boolean {
  if (typeof msg.path !== "string" || typeof msg.sessionId !== "string" || typeof msg.requestId !== "string") {
    return false;
  }
  if (msg.path.length === 0 || msg.path.length > MAX_PREVIEW_PATH_LENGTH) {
    return false;
  }
  if (msg.path.includes("\x00")) {
    return false;
  }
  if (msg.sessionId.length > MAX_ID_LENGTH || msg.requestId.length > MAX_ID_LENGTH) {
    return false;
  }
  return true;
}
