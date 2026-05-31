/**
 * Shared section human-human-involvement metadata builder.
 *
 * Eliminates the duplicated 4-way pre-fetch → commit map → evaluate loop
 * between GET /documents/:docPath and GET /documents/:docPath/sections.
 */

import path from "node:path";
import type { Request } from "express";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { resolveAllSectionPaths } from "../../storage/heading-resolver.js";
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-commit-history.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import type { WsServerEvent, AttributionWriterType, SectionAgentWritePolicySummary } from "../../types/shared.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";

const SECTION_LENGTH_WARNING_THRESHOLD = 2000; // words

function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

export interface SectionInvolvementMeta {
  /**
   * Section-level agent-write-policy summary (spec 12). Replaces the old
   * hardcoded `humanInvolvement_score`; the generic part is `canWrite`, with the
   * human-involvement compatibility policy's `score` carried inside its details.
   */
  agentWritePolicy: SectionAgentWritePolicySummary;
  crdt_session_active: boolean;
  section_length_warning: boolean;
  word_count: number;
  last_editor?: { id: string; name: string; timestampMs: number; type: AttributionWriterType; seconds_ago: number };
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
 * @param docPath - the document path
 * @param headingPaths - all heading paths to evaluate
 * @param bulkContent - pre-loaded section content (keyed by headingPath.join(">>"))
 * @returns Map keyed by headingKey → section metadata
 */
export async function buildSectionInvolvementMeta(
  docPath: string,
  headingPaths: string[][],
  bulkContent: Map<string, string>,
): Promise<Map<string, SectionInvolvementMeta>> {
  const [gitCommitInfo, canonicalPaths] = await Promise.all([
    readDocSectionCommitInfo(docPath),
    resolveAllSectionPaths(getContentRoot(), docPath),
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
    try {
      const headingKey = SectionRef.headingKey(headingPath);
      const content = bulkContent.get(headingKey) ?? "";

      const agentWritePolicy = await AgentWritePolicy.summarizeSection(
        new SectionRef(docPath, headingPath),
        gitCommitInfo,
      );
      const wordCount = countWords(content);
      const lengthWarning = wordCount > SECTION_LENGTH_WARNING_THRESHOLD;

      const commitInfo = commitByHeading.get(headingKey);
      const nowMs = Date.now();
      result.set(headingKey, {
        agentWritePolicy,
        crdt_session_active: crdtSessionActive,
        section_length_warning: lengthWarning,
        word_count: wordCount,
        last_editor: commitInfo
          ? {
              id: commitInfo.writerId,
              name: commitInfo.authorName,
              timestampMs: commitInfo.timestampMs,
              type: commitInfo.writerType,
              seconds_ago: Math.max(0, (nowMs - commitInfo.timestampMs) / 1000),
            }
          : {
              id: "unknown",
              name: "unknown",
              timestampMs: 0,
              type: "unknown" as AttributionWriterType,
              seconds_ago: 0,
            },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  return result;
}

/**
 * Broadcast agent:reading WebSocket event if the request is from an agent.
 */
export function broadcastAgentReading(
  req: Request,
  docPath: string,
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
