// src/providers/hoverPreviewSettings.ts — Host-side settings reader for the
// hover-preview feature. Reads from `vscode.workspace.getConfiguration` and
// returns a typed snapshot the webview can consume.
//
// See: asimov/changes/add-hover-file-preview/design.md D17 (settings + footer)

import * as vscode from "vscode";
import type { HoverPreviewSettings } from "../types/messages";

const SECTION = "anywhereTerminal.hoverPreview";

/**
 * Defaults mirror `contributes.configuration` in `package.json`. Keep these in
 * sync — `getConfiguration().get(key, default)` uses these only as a final
 * fallback when the setting is absent from BOTH user and workspace scopes.
 */
const DEFAULTS: HoverPreviewSettings = {
  delay: 300,
  blockSensitive: true,
};

/** Clamp `delay` to the JSON-schema range so a malicious workspace can't override. */
function clampDelay(n: number): number {
  if (!Number.isFinite(n)) {
    return DEFAULTS.delay;
  }
  return Math.max(100, Math.min(2000, Math.round(n)));
}

/**
 * Read the current hover-preview settings snapshot.
 *
 * `blockSensitive` is a SECURITY BOUNDARY, not a project preference. Even
 * though the JSON schema declares `scope: "application"`, `cfg.get()` would
 * still return a merged value that honors workspace overrides if a malicious
 * workspace shipped `.vscode/settings.json` with a stale-key fallback. We use
 * `inspect()` and read ONLY the global/default values to prevent a hostile
 * repo from disabling the trust policy. See: round-2 WARN W2.
 *
 * `delay` is a benign UX preference — workspace overrides are fine there.
 */
export function readHoverPreviewSettings(): HoverPreviewSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const inspected = cfg.inspect<boolean>("blockSensitive");
  const blockSensitive = inspected?.globalValue ?? inspected?.defaultValue ?? DEFAULTS.blockSensitive;
  return {
    delay: clampDelay(cfg.get<number>("delay", DEFAULTS.delay)),
    blockSensitive,
  };
}

/**
 * Push a setting change back to vscode's configuration store. Returns a
 * Thenable so callers can await persistence. Validates `key` and `value` are
 * within the contributed schema before delegating to `update()`.
 */
export async function updateHoverPreviewSetting(
  key: keyof HoverPreviewSettings,
  value: boolean | number,
): Promise<void> {
  let resolved: boolean | number;
  if (key === "blockSensitive") {
    if (typeof value !== "boolean") {
      return;
    }
    resolved = value;
  } else if (key === "delay") {
    if (typeof value !== "number") {
      return;
    }
    resolved = clampDelay(value);
  } else {
    return;
  }
  const cfg = vscode.workspace.getConfiguration(SECTION);
  // `Global` target makes the setting persist across workspaces — matches user
  // expectation for a UI-controlled preference (not a per-project knob).
  await cfg.update(key, resolved, vscode.ConfigurationTarget.Global);
}

/** True when a `ConfigurationChangeEvent` touches any of the hover-preview keys. */
export function affectsHoverPreview(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
