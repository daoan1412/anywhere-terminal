// src/webview/vault/format.ts — Pure, DOM-free formatting + path helpers for the
// AI-vault panel. No `this`, no side effects — independently unit-testable.

import type { VaultSessionDetail } from "../../vault/types";
import { getAgentDisplayName } from "./agentIcons";

/** Last path segment (folder leaf) for the cwd chip. */
export function leafSegment(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed || cwd;
}

/** Drop leading/trailing separators and collapse consecutive ones. */
export function collapseSeparators<T>(items: (T | "sep")[]): (T | "sep")[] {
  const out: (T | "sep")[] = [];
  for (const it of items) {
    if (it === "sep") {
      if (out.length === 0 || out[out.length - 1] === "sep") {
        continue;
      }
    }
    out.push(it);
  }
  while (out.length > 0 && out[out.length - 1] === "sep") {
    out.pop();
  }
  return out;
}

/** Compact token count: 1650 → "1.6k". */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Activity summary line: "24 msgs · 18.2k tok · 8 tools · 1 subagent". */
export function formatStats(stats: VaultSessionDetail["stats"]): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [plural(stats.messageCount, "msg")];
  if (stats.tokenCount !== undefined) {
    parts.push(`${formatTokens(stats.tokenCount)} tok`);
  }
  parts.push(plural(stats.toolCount, "tool"));
  if (stats.subagentCount > 0) {
    parts.push(plural(stats.subagentCount, "subagent"));
  }
  return parts.join(" · ");
}

/** True iff `child` equals `parent` or sits inside its subtree (either separator). */
export function isWithin(child: string, parent: string): boolean {
  if (!child || !parent) {
    return false;
  }
  // Strip trailing separators so a trailing-slash parent (`/a/b/`) and a root
  // (`/`) compare correctly without falling into the sibling-prefix trap
  // (`/a/b` must NOT match `/a/bc`). A parent that normalizes to empty was a
  // filesystem root → it contains every absolute path.
  const strip = (p: string): string => p.replace(/[/\\]+$/, "");
  const c = strip(child);
  const p = strip(parent);
  if (p === "") {
    return true;
  }
  return c === p || c.startsWith(`${p}/`) || c.startsWith(`${p}\\`);
}

export function agentLabel(agent: string): string {
  return getAgentDisplayName(agent) ?? agent;
}

/** "just now" / "5m" / "3h" / "2d" / "Jan 5" — compact relative age. */
export function formatRelativeTime(epochMs: number, now: number = Date.now()): string {
  const diff = now - epochMs;
  if (!Number.isFinite(epochMs) || epochMs <= 0 || diff < 0) {
    return "";
  }
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) {
    return "just now";
  }
  if (diff < hour) {
    return `${Math.floor(diff / min)}m ago`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}h ago`;
  }
  if (diff < 7 * day) {
    return `${Math.floor(diff / day)}d ago`;
  }
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
