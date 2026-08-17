/**
 * Shared section human-human-involvement metadata builder.
 *
 * Eliminates the duplicated 4-way pre-fetch → commit map → evaluate loop
 * between the canonical assembled-document read and the canonical/workspace
 * section-list reads (GET /canonical/:docPath, GET /canonical/:docPath/sections,
 * GET /workspace/:docPath/sections).
 */

import path from "node:path";
import type { Request } from "express";
import { getDataRoot } from "../../storage/data-root.js";
import { resolveAllCanonicalSectionPaths } from "../../storage/heading-resolver.js";
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-commit-history.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import type { WsServerEvent, AttributionWriterType, SectionAgentWritePolicySummary } from "../../types/shared.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";
import { DocPath } from "../../types/shared.js";

export interface SectionInvolvementMeta {
  /**
   * Section-level agent-write-policy summary (spec 12). Replaces the old
   * hardcoded `humanInvolvement_score`; the generic part is `canWrite`, with the
   * human-involvement compatibility policy's `score` carried inside its details.
   */
  agentWritePolicy: SectionAgentWritePolicySummary;
  crdt_session_active: boolean;
  last_editor: { id: string; name: string; timestampMs: number; type: AttributionWriterType; seconds_ago: number } | null;
}

/**
 * Pre-fetch per-document commit history once, then derive each section's
 * agent-write-policy summary from the selected policy.
 *
 * NOTE: live-session liveness is now doc-scoped (one DocSession per document),
 * so `crdt_session_active` is sourced from `lookupDocSession(docPath)` rather
 * than the deleted per-section `SectionPresence` checks. The dirty-file /
 * human-proposal-lock prefetch is gone — those concerns moved to the FSM-lock
 * subsystem (Area F) and are no longer part of the section read-API summary.
 *
 * Body content is not required: word-count / length-warning metadata was removed
 * as unused, and agent-write-policy / last-editor are derived from commit info.
 *
 * @param docPath - the document path
 * @param headingPaths - all heading paths to evaluate
 * @returns Map keyed by headingKey → section metadata
 */
export async function buildSectionInvolvementMeta(
  docPath: DocPath,
  headingPaths: string[][],
): Promise<Map<string, SectionInvolvementMeta>> {
  const [gitCommitInfo, canonicalPaths] = await Promise.all([
    readDocSectionCommitInfo(docPath),
    resolveAllCanonicalSectionPaths(docPath),
  ]);

  // Build heading-keyed commit map by joining git info with resolved paths
  const commitByHeading = new Map<string, SectionCommitInfo>();
  for (const [headingKey, resolved] of canonicalPaths) {
    const relFromDataRoot = path.relative(getDataRoot(), resolved.absolutePath);
    const info = gitCommitInfo.get(relFromDataRoot);
    if (info) commitByHeading.set(headingKey, info);
  }

  const crdtSessionActive = lookupDocSession(docPath) !== undefined;

  const result = new Map<string, SectionInvolvementMeta>();

  for (const headingPath of headingPaths) {
    const headingKey = SectionRef.headingKey(headingPath);
    const commitInfo = commitByHeading.get(headingKey);

    // O(1): derive the summary from the already-resolved per-section commit
    // info. Do NOT call summarizeSection here — it re-resolves the heading (a
    // full skeleton reparse) per section, which is quadratic across a document.
    const agentWritePolicy = AgentWritePolicy.summarizeSectionFromCommitInfo(
      new SectionRef(docPath, headingPath),
      commitInfo ?? null,
    );
    const nowMs = Date.now();
    result.set(headingKey, {
      agentWritePolicy,
      crdt_session_active: crdtSessionActive,
      last_editor: commitInfo
        ? {
          id: commitInfo.writerId,
          name: commitInfo.authorName,
          timestampMs: commitInfo.timestampMs,
          type: commitInfo.writerType,
          seconds_ago: Math.max(0, (nowMs - commitInfo.timestampMs) / 1000),
        }
        : null,
    });
  }

  return result;
}

/**
 * Broadcast agent:reading WebSocket event if the request is from an agent.
 */
export function broadcastAgentReading(
  req: Request,
  docPath: DocPath,
  headingPaths: string[][],
  onWsEvent?: (event: WsServerEvent) => void,
): void {
  const writer = resolveAuthenticatedWriter(req);
  if (writer?.type === "agent" && onWsEvent) {
    onWsEvent({
      type: "agent:reading",
      actor_id: writer.id,
      actor_display_name: writer.displayName,
      doc_path: docPath,
      heading_paths: headingPaths,
    });
  }
}
