// Shared PTY trigger bytes for AI-CLI image paste (Claude Code, Codex, Grok).
// Image bytes never traverse the PTY — CLIs read the OS clipboard out-of-band
// after detecting one of these signals. See preview-pasted-images discovery §1.

/** Bracketed-paste wrapper with empty payload (Claude / OpenCode on macOS Cmd+V). */
export const BRACKETED_EMPTY_PASTE = "\x1b[200~\x1b[201~";

/** Ctrl+V byte (Codex / Grok / Claude on Linux). */
export const CTRL_V_PASTE = "\x16";

/**
 * PTY bytes that tell the running AI CLI to read an image from the OS clipboard.
 * Linux CLIs key off Ctrl+V; macOS CLIs also accept empty bracketed paste.
 */
export function getImagePastePtyTrigger(isMac: boolean): string {
  return isMac ? BRACKETED_EMPTY_PASTE : CTRL_V_PASTE;
}