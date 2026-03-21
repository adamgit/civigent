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
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-activity.js";
import { SectionPresence } from "../../domain/section-presence.js";
import { SectionGuard } from "../../domain/section-guard.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { WsServerEvent } from "../../types/shared.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";

const SECTION_LENGTH_WARNING_THRESHOLD = 2000; // words

function countWords(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

export interface SectionInvolvementMeta {
  humanInvolvement_score: number;
  crdt_session_active: boolean;
  section_length_warning: boolean;
  word_count: number;
  last_human_editor?: { name: string; timestampMs: number };
}

/**
 * Pre-fetch all human-involvement-related data and evaluate each section.
 *
 * @param docPath - the document path
 * @param headingPaths - all heading paths to evaluate
 * @param bulkContent - pre-loaded section content (keyed by headingPath.join(">>"))
 * @returns Map keyed by headingKey → human-involvement metadata
 */
export async function buildSectionInvolvementMeta(
  docPath: string,
  headingPaths: string[][],
  bulkContent: Map<string, string>,
): Promise<Map<string, SectionInvolvementMeta>> {
  const [dirtyFileSet, gitCommitInfo, canonicalPaths, humanProposalLockIndex] = await Promise.all([
    SectionPresence.prefetchDirtyFiles(docPath),
    readDocSectionCommitInfo(docPath, headingPaths.length),
    resolveAllSectionPaths(getContentRoot(), docPath),
    SectionPresence.prefetchHumanProposalLocks(),
  ]);

  // Build heading-keyed commit map by joining git info with resolved paths
  const commitByHeading = new Map<string, SectionCommitInfo>();
  for (const [headingKey, resolved] of canonicalPaths) {
    const relFromDataRoot = path.relative(getDataRoot(), resolved.absolutePath);
    const info = gitCommitInfo.get(relFromDataRoot);
    if (info) commitByHeading.set(headingKey, info);
  }

  const result = new Map<string, SectionInvolvementMeta>();

  for (const headingPath of headingPaths) {
    try {
      const headingKey = SectionRef.headingKey(headingPath);
      const content = bulkContent.get(headingKey) ?? "";

      const verdict = SectionGuard.evaluateWithPrefetch(
        { doc_path: docPath, heading_path: headingPath },
        dirtyFileSet, commitByHeading, humanProposalLockIndex,
      );
      const wordCount = countWords(content);
      const lengthWarning = wordCount > SECTION_LENGTH_WARNING_THRESHOLD;

      const commitInfo = commitByHeading.get(headingKey);
      result.set(headingKey, {
        humanInvolvement_score: verdict.humanInvolvement_score,
        crdt_session_active: SectionPresence.checkLiveSessionOnly(
          new SectionRef(docPath, headingPath),
        ),
        section_length_warning: lengthWarning,
        word_count: wordCount,
        last_human_editor: commitInfo
          ? { name: commitInfo.authorName, timestampMs: commitInfo.timestampMs }
          : undefined,
      });
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
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
