import {
  AdminConfigValidationError,
  getAdminConfig,
  updateAdminConfig,
} from "../../admin-config.js";
import { HUMAN_INVOLVEMENT_PRESETS, RoleName } from "../../types/shared.js";
import type {
  AclSnapshot,
  AdminConfig,
  ContentIntegrityFailure,
  CreateCustomRoleRequest,
  DocumentTreeEntry,
  GetActivityResponse,
  GetAdminGitBackupStatusResponse,
  GetAdminGitRestoreStatusResponse,
  GetAdminRuntimeMemoryResponse,
  GetAdminSnapshotHealthResponse,
  GetAdminSnapshotHistoryResponse,
  RunAdminContentIntegrityScanResponse,
  RunAdminGitBackupResponse,
  RunAdminGitRestoreResponse,
  SetAclDefaultsRequest,
  SetDocumentAclRequest,
  SetUserRolesRequest,
  VerifyAdminGitBackupResponse,
} from "../../types/shared.js";
import { getRuntimeMemoryStats } from "../../runtime/memory-stats.js";
import {
  GitBackupOperationError,
  getGitBackupStatus,
  getGitRestoreStatus,
  runGitRestore,
  runQuietStateGitBackup,
  verifyGitBackup,
} from "../../backup/git-backup-service.js";
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
import {
  listProposalsToleratingUndecodable,
  readActiveProposal,
  rewriteProposalMeta,
  ProposalNotFoundError,
} from "../../storage/proposal-repository.js";
import { findProposalDefectDetector } from "../../domain/proposal-defect-detectors.js";
import type { ActiveProposal, AnyProposal } from "../../types/shared.js";
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
import { ContentLayer } from "../../storage/content-layer.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";
import { DocPath } from "../../types/shared.js";

export {
  AdminConfigValidationError,
  SnapshotGenerationDisabledError,
  SnapshotRootNotWritableError,
  GitBackupOperationError,
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

// ─── Runtime memory ─────────────────────────────────────

export function getRuntimeMemory(): GetAdminRuntimeMemoryResponse {
  return getRuntimeMemoryStats();
}

// ─── Git backup / restore ───────────────────────────────

export async function readGitBackupStatus(): Promise<GetAdminGitBackupStatusResponse> {
  return getGitBackupStatus();
}

export async function runGitBackup(): Promise<RunAdminGitBackupResponse> {
  return runQuietStateGitBackup();
}

export async function verifyGitBackupRefs(): Promise<VerifyAdminGitBackupResponse> {
  return verifyGitBackup();
}

export async function readGitRestoreStatus(): Promise<GetAdminGitRestoreStatusResponse> {
  return getGitRestoreStatus();
}

export async function runGitBackupRestore(): Promise<RunAdminGitRestoreResponse> {
  return runGitRestore();
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

// ─── Proposal defect autofix ────────────────────────────

export type AutofixProposalResult =
  | { ok: false; status: number; message: string }
  | { ok: true; proposal: AnyProposal };

/**
 * Run a named defect detector's autofix on a single proposal and persist the
 * repair. Returns a typed failure (404 unknown detector / 404 missing proposal /
 * 409 not-degraded) or the repaired proposal. The repair must clear the marker;
 * the storage write boundary backstops it.
 */
export async function autofixProposalDefect(
  id: string,
  detectorId: string,
): Promise<AutofixProposalResult> {
  const detector = findProposalDefectDetector(detectorId);
  if (!detector) {
    return { ok: false, status: 404, message: `Unknown proposal defect detector: ${detectorId}.` };
  }
  let proposal: ActiveProposal;
  try {
    proposal = await readActiveProposal(id);
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return { ok: false, status: 404, message: `Proposal not found: ${id}.` };
    }
    throw error;
  }
  if (!detector.detect(proposal)) {
    return {
      ok: false,
      status: 409,
      message: `Proposal ${id} does not exhibit defect "${detectorId}"; nothing to autofix.`,
    };
  }
  const repaired = detector.fix(proposal);
  const persisted = await rewriteProposalMeta(id, repaired);
  return { ok: true, proposal: persisted };
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
  const { proposals: allProposals } = await listProposalsToleratingUndecodable();
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

export async function getAcl(): Promise<AclSnapshot> {
  return getAclSnapshot();
}

export async function setAclDefaults(request: SetAclDefaultsRequest): Promise<void> {
  await updateDefaults(request);
}

export async function setDocAclEntry(docPath: DocPath, request: SetDocumentAclRequest): Promise<void> {
  await setDocAcl(docPath, request);
}

export async function removeDocAclEntry(docPath: DocPath): Promise<void> {
  await removeDocAcl(docPath);
}

export async function setRoles(userId: string, request: SetUserRolesRequest): Promise<void> {
  await setUserRoles(userId, request.roles);
}

export async function removeRoles(userId: string): Promise<void> {
  await removeUserRoles(userId);
}

export async function createCustomRole(request: CreateCustomRoleRequest): Promise<void> {
  await addCustomRole(request.name);
}

export async function removeCustomRole(name: string): Promise<void> {
  await deleteCustomRole(RoleName.of(name));
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
    const docPath = DocPath.parse(entry.path);

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
      const commitInfo = commitByHeading.get(headingKey);
      // O(1): use the already-resolved per-section commit info. Do NOT call
      // summarizeSection here — it re-resolves the heading (a full skeleton
      // reparse) per section, which is quadratic across the document and, over
      // every document, hangs the server.
      const agentWritePolicy = AgentWritePolicy.summarizeSectionFromCommitInfo(
        new SectionRef(docPath, headingPath),
        commitInfo ?? null,
      );

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
  }

  const preset = HUMAN_INVOLVEMENT_PRESETS[config.humanInvolvement_preset];
  return {
    preset: config.humanInvolvement_preset,
    humanInvolvement_midpoint_seconds: preset.midpoint_seconds,
    humanInvolvement_steepness: preset.steepness,
    sections,
  };
}

// ─── Canonical content integrity scan ───────────────────

function flattenDocumentTreePaths(entries: DocumentTreeEntry[]): DocPath[] {
  const docPaths: DocPath[] = [];
  const walk = (nodes: DocumentTreeEntry[]): void => {
    for (const node of nodes) {
      if (node.type === "file") {
        docPaths.push(DocPath.parse(node.path));
        continue;
      }
      walk(node.children ?? []);
    }
  };
  walk(entries);
  return docPaths;
}

function formatScanError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

/**
 * Walk every canonical document skeleton and attempt `readAllSections` — the
 * same assembly path the document page uses. Failures (missing body files,
 * corrupt skeletons, etc.) are collected with full stacks. Nothing is written.
 */
export async function scanContentIntegrity(): Promise<RunAdminContentIntegrityScanResponse> {
  const started = Date.now();
  const tree = await readDocumentsTree("/", true);
  const docPaths = flattenDocumentTreePaths(tree);
  const layer = new ContentLayer(getContentRoot());
  const failures: ContentIntegrityFailure[] = [];

  for (const docPath of docPaths) {
    try {
      await layer.readAllSections(docPath);
    } catch (error) {
      failures.push({
        doc_path: docPath,
        error: formatScanError(error),
      });
    }
  }

  return {
    scanned_count: docPaths.length,
    ok_count: docPaths.length - failures.length,
    failure_count: failures.length,
    duration_ms: Date.now() - started,
    failures,
  };
}

// ─── Agent MCP activity log ─────────────────────────────

export async function getAgentActivity(): Promise<{ sessions: unknown[] }> {
  const { readFileIfExists } = await import("../../storage/fs-primitives.js");
  const { getMonitoringRoot } = await import("../../storage/data-root.js");
  const logPath = (await import("node:path")).join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
  // A genuinely absent log file means no agent activity has been recorded yet —
  // a valid empty state. Any other read failure (permission, I/O) propagates.
  const raw = await readFileIfExists(logPath);
  if (raw === null) {
    return { sessions: [] };
  }
  const sessions = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  return { sessions };
}
