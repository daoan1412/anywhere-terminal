// src/vault/readers/claudeChildren.ts — Claude nested children: subagent (`Task`/
// `Agent`) transcripts and `/workflow` runs (nest-workflow-team-sessions D2/D3).
// Discovers lazy stubs for the parent preview and resolves each child id to its
// own bounded detail. Every path is id-derived + containment-checked (claudePaths).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { boundedPreview } from "../preview";
import { formatEntryId, type VaultSessionDetail } from "../types";
import { formatWorkflowAgentSessionId, formatWorkflowSessionId } from "./claudeChildIds";
import {
  type ClaudeReaderOptions,
  claudeRoots,
  isSafeSessionId,
  resolveClaudeSessionPath,
  resolveClaudeSubagentPath,
  resolveClaudeWorkflowAgentPath,
  SUBAGENT_MARKER,
  WORKFLOW_AGENT_STEM_RE,
  WORKFLOW_ID_RE,
} from "./claudePaths";
import { coerceTimestamp, readFirstUserRecord, readManifestJson, streamClaudeRecords } from "./claudeRecords";
import {
  type ClaudeChildStub,
  classifyClaudeStyleEvents,
  finalizeDetail,
  synthesizeGroupDetail,
} from "./detail";

/** A flat subagent leaf: its records are all `isSidechain` (that IS the
 *  conversation here), so classify with `includeSidechain`. */
export async function readClaudeSubagentDetail(
  parentId: string,
  stem: string,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  const filePath = await resolveClaudeSubagentPath(parentId, stem, options);
  if (!filePath) {
    return null;
  }
  const read = await streamClaudeRecords(filePath);
  if (read === null) {
    return null;
  }
  const detail = classifyClaudeStyleEvents(read.records, { limit, includeSidechain: true });
  return finalizeDetail(formatEntryId("claude", sessionId), detail, read.truncated);
}

/**
 * Workflow GROUP detail (D3): list the run's agents under
 * `<parentId>/subagents/workflows/<wfId>/` as title-only nested sessions (each a
 * lazy `:wfagent:` leaf), labelled by their first prompt. The manifest's summary
 * leads the group. Parent/dir unknown → null.
 */
export async function readClaudeWorkflowDetail(
  parentId: string,
  wfId: string,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  if (!isSafeSessionId(parentId) || !WORKFLOW_ID_RE.test(wfId)) {
    return null;
  }
  const parentPath = await resolveClaudeSessionPath(parentId, options);
  if (!parentPath) {
    return null;
  }
  const projectDir = path.dirname(parentPath);
  const { projectsDir } = claudeRoots(options);
  const agentsDir = path.join(projectDir, parentId, "subagents", "workflows", wfId);
  const agentsRel = path.relative(projectsDir, agentsDir);
  if (agentsRel.startsWith("..") || path.isAbsolute(agentsRel)) {
    return null;
  }
  // Manifest summary leads the group (best-effort; bounded + defensive, W5/D8).
  const manifest = await readManifestJson(path.join(projectDir, parentId, "workflows", `${wfId}.json`));
  const summary = manifest && typeof manifest.summary === "string" ? manifest.summary : undefined;
  let files: string[];
  try {
    files = await fs.readdir(agentsDir);
  } catch {
    return null; // no agents dir → the workflow id doesn't resolve
  }
  const stems = files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((s) => WORKFLOW_AGENT_STEM_RE.test(s))
    .sort();
  const children: ClaudeChildStub[] = [];
  for (const stem of stems) {
    const first = await readFirstUserRecord(path.join(agentsDir, `${stem}.jsonl`));
    children.push({
      entryId: formatEntryId("claude", formatWorkflowAgentSessionId(parentId, wfId, stem)),
      description: first?.text ? boundedPreview(first.text) : stem,
      isGroup: true, // title-only: the first-prompt label, no agent chip
      ...(first?.text ? { firstMessage: first.text } : {}),
      ...(first?.timestamp ? { timestamp: first.timestamp } : {}),
    });
  }
  return synthesizeGroupDetail(formatEntryId("claude", sessionId), children, {
    firstPrompt: summary,
    subagentCount: children.length,
    limit,
  });
}

/** A workflow agent leaf (D3): its records are all `isSidechain` (the agent's own
 *  conversation), so classify with `includeSidechain`. */
export async function readClaudeWorkflowAgentDetail(
  parentId: string,
  wfId: string,
  stem: string,
  sessionId: string,
  options: ClaudeReaderOptions,
  limit: number | undefined,
): Promise<VaultSessionDetail | null> {
  const filePath = await resolveClaudeWorkflowAgentPath(parentId, wfId, stem, options);
  if (!filePath) {
    return null;
  }
  const read = await streamClaudeRecords(filePath);
  if (read === null) {
    return null;
  }
  const detail = classifyClaudeStyleEvents(read.records, { limit, includeSidechain: true });
  return finalizeDetail(formatEntryId("claude", sessionId), detail, read.truncated);
}

/**
 * Discover the parent session's `/workflow` runs (D3) as one collapsed GROUP stub
 * per run. Manifests live at `<parentId>/workflows/wf_*.json`; the stub's label
 * and placement come from the manifest (the parent's `Workflow` tool call has no
 * run id). A missing `workflows/` dir → `[]`; a malformed manifest is skipped.
 */
export async function listClaudeWorkflowStubs(
  parentId: string,
  options: ClaudeReaderOptions = {},
): Promise<ClaudeChildStub[]> {
  if (!isSafeSessionId(parentId)) {
    return [];
  }
  const parentPath = await resolveClaudeSessionPath(parentId, options);
  if (!parentPath) {
    return [];
  }
  const wfDir = path.join(path.dirname(parentPath), parentId, "workflows");
  const { projectsDir } = claudeRoots(options);
  const rel = path.relative(projectsDir, wfDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return [];
  }
  let files: string[];
  try {
    files = await fs.readdir(wfDir);
  } catch {
    return []; // no workflows dir → the common case
  }
  const stubs: ClaudeChildStub[] = [];
  for (const name of files) {
    if (!name.startsWith("wf_") || !name.endsWith(".json")) {
      continue;
    }
    const wfId = name.slice(0, -".json".length);
    if (!WORKFLOW_ID_RE.test(wfId)) {
      continue;
    }
    const manifest = await readManifestJson(path.join(wfDir, name));
    if (!manifest) {
      continue; // missing / oversized / malformed — skip, don't throw (W5/D8)
    }
    const wfName = typeof manifest.workflowName === "string" ? manifest.workflowName : wfId;
    const agentCount = typeof manifest.agentCount === "number" ? manifest.agentCount : Number(manifest.agentCount) || 0;
    const status = typeof manifest.status === "string" ? manifest.status : "";
    const summary = typeof manifest.summary === "string" ? manifest.summary : undefined;
    const ts = coerceTimestamp(manifest.startTime) ?? coerceTimestamp(manifest.timestamp);
    const label = `Workflow: ${wfName} · ${agentCount} agent${agentCount === 1 ? "" : "s"}${status ? ` · ${status}` : ""}`;
    stubs.push({
      entryId: formatEntryId("claude", formatWorkflowSessionId(parentId, wfId)),
      description: label,
      isGroup: true,
      ...(summary ? { firstMessage: summary } : {}),
      ...(ts !== undefined ? { timestamp: ts } : {}),
    });
  }
  stubs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return stubs;
}

/**
 * Discover a parent session's subagents: `<projects>/<dir>/<parentId>/subagents/`
 * holds `<stem>.jsonl` transcripts + `<stem>.meta.json` (`{agentType, description}`).
 * Returns a lazy stub per subagent (entryId + meta + first prompt) — fail-safe to
 * `[]` (a missing dir / unreadable meta just yields no nesting).
 */
export async function listClaudeSubagentStubs(
  parentId: string,
  options: ClaudeReaderOptions,
): Promise<ClaudeChildStub[]> {
  if (!isSafeSessionId(parentId)) {
    return [];
  }
  const { projectsDir } = claudeRoots(options);
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  for (const dir of projectDirs) {
    const subagentsDir = path.join(projectsDir, dir, parentId, "subagents");
    const rel = path.relative(projectsDir, subagentsDir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    let files: string[];
    try {
      files = await fs.readdir(subagentsDir);
    } catch {
      continue; // no subagents dir under this project — try the next
    }
    const stems = files.filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
    const stubs: ClaudeChildStub[] = [];
    for (const stem of stems) {
      if (!isSafeSessionId(stem)) {
        continue;
      }
      const meta = await readSubagentMeta(path.join(subagentsDir, `${stem}.meta.json`));
      const first = await readFirstUserRecord(path.join(subagentsDir, `${stem}.jsonl`));
      stubs.push({
        entryId: formatEntryId("claude", `${parentId}${SUBAGENT_MARKER}${stem}`),
        agentType: meta?.agentType,
        description: meta?.description,
        firstMessage: first?.text,
        timestamp: first?.timestamp,
      });
    }
    return stubs;
  }
  return [];
}

/** Read a subagent's `{agentType, description}` meta sidecar (best-effort). */
async function readSubagentMeta(metaPath: string): Promise<{ agentType?: string; description?: string } | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") {
      return null;
    }
    return {
      agentType: typeof obj.agentType === "string" ? obj.agentType : undefined,
      description: typeof obj.description === "string" ? obj.description : undefined,
    };
  } catch {
    return null;
  }
}
