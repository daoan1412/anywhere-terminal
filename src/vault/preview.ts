// src/vault/preview.ts — Shared D4 title-preview bound.
// See: design.md D4, specs/agent-session-index/spec.md (Metadata-only, bounded
// title preview, no egress).
//
// A session title is the ONLY transcript-derived value the vault touches; it
// originates from a user message and may contain secrets, so every reader funnels
// it through here: collapse all whitespace (strip newlines) then cap at 120 chars.

const MAX_TITLE_CHARS = 120;

export function boundedPreview(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE_CHARS ? oneLine.slice(0, MAX_TITLE_CHARS) : oneLine;
}
