import {
  AdminConfigValidationError,
  getAdminConfig,
  updateAdminConfig,
} from "../../admin-config.js";
import { HUMAN_INVOLVEMENT_PRESETS } from "../../types/shared.js";
import type {
  AdminConfig,
  GetActivityResponse,
  GetAdminSnapshotHealthResponse,
  GetAdminSnapshotHistoryResponse,
} from "../../types/shared.js";
import { readActivity } from "../../storage/activity-reader.js";
import {
  getSnapshotHealth,
  getSnapshotHistory,
  snapshotAllDocs,
  SnapshotGenerationDisabledError,
  SnapshotRootNotWritableError,
} from "../../storage/snapshot.js";
import {
  getAclSnapshot,
  updateDefaults,
  setDocAcl,
  removeDocAcl,
  setUserRoles,
  removeUserRoles,
  addCustomRole,
  deleteCustomRole,
} from "../../auth/acl.js";
import {
  readAgentKeysAndErrors,
  readAgentKeysSkipErrors,
  addAgentKey,
  removeAgentKey,
  rotateAgentSecret,
  lookupAgentKey,
} from "../../auth/agent-keys.js";
import { listAllProposals } from "../../storage/proposal-repository.js";
import path from "node:path";
import type { GetHeatmapResponse, HeatmapEntry } from "../../types/shared.js";
import { readDocumentsTree } from "../../storage/documents-tree.js";
import {
  readDocumentStructure,
  flattenStructureToHeadingPaths,
  resolveAllSectionPaths,
} from "../../storage/heading-resolver.js";
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-commit-history.js";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";

export {
  AdminConfigValidationError,
  SnapshotGenerationDisabledError,
  SnapshotRootNotWritableError,
};

// ─── Config ─────────────────────────────────────────────

export function getAdminConfigWithDescription(): AdminConfig & { preset_description: string } {
  const config = getAdminConfig();
  const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
  return { ...config, preset_description: preset.description };
}

export function updateAdminConfigWithDescription(body: Partial<AdminConfig>): AdminConfig & { preset_description: string } {
  const updated = updateAdminConfig(body);
  const preset = HUMAN_INVOLVEMENT_PRESETS[updated.humanInvolvement_preset];
  return { ...updated, preset_description: preset.description };
}

// ─── Snapshots ──────────────────────────────────────────

export async function readSnapshotHealth(): Promise<GetAdminSnapshotHealthResponse> {
  return getSnapshotHealth();
}

export async function readSnapshotHistory(): Promise<GetAdminSnapshotHistoryResponse> {
  return getSnapshotHistory();
}

export async function triggerSnapshotNow(): Promise<void> {
  await snapshotAllDocs();
}

// ─── Activity ───────────────────────────────────────────

export async function getActivity(limit: number, days: number): Promise<GetActivityResponse> {
  const items = await readActivity(limit, days);
  return { items };
}

// ─── Agent keys ─────────────────────────────────────────

export async function listAgents() {
  const { entries, errors } = await readAgentKeysAndErrors();
  return {
    agents: entries.map((e) => ({ agent_id: e.agentId, display_name: e.displayName })),
    errors,
  };
}

export async function createAgent(displayName: string, agentId: string | undefined, generateSecret: boolean) {
  const id = (typeof agentId === "string" && agentId.trim())
    ? agentId.trim()
    : `agent-${crypto.randomUUID()}`;
  const plainSecret = await addAgentKey(id, displayName.trim(), generateSecret);
  return { agent_id: id, display_name: displayName.trim(), secret: plainSecret };
}

export async function deleteAgent(agentId: string): Promise<boolean> {
  return removeAgentKey(agentId);
}

export async function rotateAgent(agentId: string) {
  const newSecret = await rotateAgentSecret(agentId);
  const entry = await lookupAgentKey(agentId);
  return { agent_id: agentId, display_name: entry?.displayName ?? "", secret: newSecret };
}

export async function getAgentsSummary() {
  const { agentEventLog } = await import("../../mcp/agent-event-log.js");
  const registeredAgents = (await readAgentKeysSkipErrors()).map((e) => ({ id: e.agentId, displayName: e.displayName }));
  const allProposals = await listAllProposals();
  const agents = agentEventLog.buildFullSummary(registeredAgents, allProposals);
  const config = getAdminConfig();
  const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
  return {
    agents,
    posture: {
      preset: config.humanInvolvement_preset,
      description: preset.description ?? config.humanInvolvement_preset,
    },
  };
}

// ─── ACL / RBAC ─────────────────────────────────────────

export async function getAcl() {
  return getAclSnapshot();
}

export async function setAclDefaults(read?: string, write?: string): Promise<void> {
  await updateDefaults({ read, write });
}

export async function setDocAclEntry(docPath: string, read?: string, write?: string): Promise<void> {
  await setDocAcl(docPath, { read, write });
}

export async function removeDocAclEntry(docPath: string): Promise<void> {
  await removeDocAcl(docPath);
}

export async function setRoles(userId: string, roles: string[]): Promise<void> {
  await setUserRoles(userId, roles);
}

export async function removeRoles(userId: string): Promise<void> {
  await removeUserRoles(userId);
}

export async function createCustomRole(name: string): Promise<void> {
  await addCustomRole(name);
}

export async function removeCustomRole(name: string): Promise<void> {
  await deleteCustomRole(name);
}

// ─── Heatmap ────────────────────────────────────────────

function flattenTree(
  entries: Array<{ name: string; path: string; type: "file" | "directory"; children?: any[] }>,
): Array<{ name: string; path: string; type: "file" | "directory" }> {
  const result: Array<{ name: string; path: string; type: "file" | "directory" }> = [];
  for (const entry of entries) {
    result.push({ name: entry.name, path: entry.path, type: entry.type });
    if (entry.children?.length) {
      result.push(...flattenTree(entry.children));
    }
  }
  return result;
}

export async function getHeatmap(): Promise<GetHeatmapResponse> {
  const config = getAdminConfig();
  const sections: HeatmapEntry[] = [];

  const tree = await readDocumentsTree("");
  for (const entry of flattenTree(tree)) {
    if (entry.type !== "file") continue;
    const docPath = entry.path;

    try {
      const structure = await readDocumentStructure(docPath);
      const headingPaths = flattenStructureToHeadingPaths(structure);

      const [gitCommitInfo, canonicalPaths] = await Promise.all([
        readDocSectionCommitInfo(docPath),
        resolveAllSectionPaths(getContentRoot(), docPath),
      ]);

      const commitByHeading = new Map<string, SectionCommitInfo>();
      for (const [headingKey, resolved] of canonicalPaths) {
        const relFromDataRoot = path.relative(getDataRoot(), resolved.absolutePath);
        const info = gitCommitInfo.get(relFromDataRoot);
        if (info) commitByHeading.set(headingKey, info);
      }

      const crdtSessionActive = lookupDocSession(docPath) !== undefined;

      for (const headingPath of headingPaths) {
        const headingKey = SectionRef.headingKey(headingPath);
        const agentWritePolicy = await AgentWritePolicy.summarizeSection(
          new SectionRef(docPath, headingPath),
          gitCommitInfo,
        );
        const commitInfo = commitByHeading.get(headingKey);

        sections.push({
          doc_path: docPath,
          heading_path: headingPath,
          agentWritePolicy,
          crdt_session_active: crdtSessionActive,
          last_human_commit_sha: commitInfo?.sha ?? null,
          last_commit_author: commitInfo?.authorName ?? null,
          last_commit_timestamp: commitInfo ? new Date(commitInfo.timestampMs).toISOString() : null,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
  return {
    preset: config.humanInvolvement_preset,
    humanInvolvement_midpoint_seconds: preset.midpoint_seconds,
    humanInvolvement_steepness: preset.steepness,
    sections,
  };
}

// ─── Agent MCP activity log ─────────────────────────────

export async function getAgentActivity(): Promise<{ sessions: unknown[] }> {
  const { readFile } = await import("node:fs/promises");
  const { getMonitoringRoot } = await import("../../storage/data-root.js");
  const logPath = (await import("node:path")).join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
  let raw: string;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch {
    return { sessions: [] };
  }
  const sessions = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  return { sessions };
}
