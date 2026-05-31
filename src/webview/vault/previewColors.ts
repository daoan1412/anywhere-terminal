// src/webview/vault/previewColors.ts — Teammate accent color sanitization for the
// vault preview (nest-workflow-team-sessions D14).
//
// Security-relevant: the `color` field is UNTRUSTED transcript data, so it is
// sanitized to a known palette or a strict hex literal before it is ever used as
// a `--turn-color` CSS custom-property value — anything else → a neutral fallback.

/**
 * Named teammate colors → concrete CSS values, so a teammate node's accent is
 * always visible under any theme. (The first team design failed by leaning on
 * theme vars like `--vscode-panel-border` that resolve to near-invisible.)
 */
const TEAMMATE_COLORS: Record<string, string> = {
  blue: "#4aa3ff",
  green: "#3fb950",
  yellow: "#d8a23a",
  purple: "#a371f7",
  cyan: "#39c5cf",
  orange: "#e0823d",
  pink: "#f778ba",
  red: "#f85149",
  magenta: "#db61a2",
  gray: "#8b949e",
  grey: "#8b949e",
};
const TEAMMATE_COLOR_FALLBACK = "#8b949e";

export function teammateAccent(color: string | undefined): string {
  if (!color) {
    return TEAMMATE_COLOR_FALLBACK;
  }
  const mapped = TEAMMATE_COLORS[color.toLowerCase()];
  if (typeof mapped === "string") {
    return mapped; // typeof-guard avoids prototype keys (toString/constructor)
  }
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : TEAMMATE_COLOR_FALLBACK;
}
