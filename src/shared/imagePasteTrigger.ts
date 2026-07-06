// Shared PTY trigger bytes for AI-CLI image paste. Image bytes never traverse
// the PTY — CLIs read the OS clipboard out-of-band after detecting one of these
// signals (preview-pasted-images discovery §1).
//
// The trigger is CLI-specific, not just OS-specific: Codex binds image paste to
// a *fixed* Ctrl+V (codex-rs `fixed.paste_image = ctrl('v')`) and ignores an
// empty bracketed paste, so it needs Ctrl+V even on macOS; OpenCode accepts
// Ctrl+V on every OS too. Claude alone relies on the OS-native signal (empty
// bracketed paste on macOS, Ctrl+V on Linux), so that path stays untouched.

import type { VaultAgentId } from "../vault/types";

/**
 * Upper bound on a single pasted image's decoded byte size. Guards against a
 * huge/accidental paste multiplying memory across webview → bridge → host
 * (base64 peaks at ~2.66x the bytes). Enforced webview-side (blob.size) and
 * host-side (decoded length).
 */
export const MAX_PASTE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Bracketed-paste wrapper with empty payload (Claude on macOS Cmd+V). */
export const BRACKETED_EMPTY_PASTE = "\x1b[200~\x1b[201~";

/** Ctrl+V byte (Codex / OpenCode / Grok on every OS; Claude on Linux). */
export const CTRL_V_PASTE = "\x16";

// CLIs that key image paste off a fixed Ctrl+V regardless of platform. "grok"
// is pre-wired ahead of its registry record — `agentKindForExecutable` cannot
// yet produce it, so it is inert until grok becomes a launchable vault agent.
// `satisfies` type-links the ids to VaultAgentId so a renamed agent id fails to
// compile here (silent wrong-trigger otherwise), while the Set stays `string`
// so `.has(agentKind: string)` needs no cast.
const CTRL_V_AGENTS = new Set<string>(["codex", "opencode", "grok"] satisfies (VaultAgentId | "grok")[]);

/**
 * PTY bytes that tell the running AI CLI to read an image from the OS clipboard.
 * Codex/OpenCode/Grok always want Ctrl+V; Claude (and unknown/shell sessions)
 * use the OS-native signal — empty bracketed paste on macOS, Ctrl+V elsewhere.
 *
 * Known limitation: `agentKind` is only known for vault-LAUNCHED sessions (the
 * caller derives it from `session.shell`). A CLI the user starts by hand in a
 * plain shell reports `agentKind: undefined`, so a hand-launched Codex/OpenCode
 * on macOS falls to the OS-native branch (bracketed paste, which Codex ignores)
 * — the Cmd+V image-forward path then no-ops. macOS Ctrl+V is unaffected: there
 * xterm emits \x16 natively and the host never sends a trigger. Detecting the
 * foreground process (not `session.shell`) would close this; out of scope here.
 */
export function getImagePastePtyTrigger(agentKind: string | undefined, isMac: boolean): string {
  if (agentKind && CTRL_V_AGENTS.has(agentKind)) {
    return CTRL_V_PASTE;
  }
  return isMac ? BRACKETED_EMPTY_PASTE : CTRL_V_PASTE;
}
