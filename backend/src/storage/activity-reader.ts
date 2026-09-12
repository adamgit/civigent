/**
 * v3 Activity Reader
 *
 * Reads activity from committed proposals (agent) and git history (human auto-commits).
 */

import path from "node:path";

import { getDataRoot, getProposalsCommittedRoot } from "./data-root.js";
import { readFileIfExists } from "./fs-primitives.js";
import { gitLogSinceForActivity } from "./git-repo.js";
import { decodeProposal } from "./proposal-file-decoder.js";
import type { ActivityItem, SectionTargetRef } from "../types/shared.js";
import { DocPath, parseJson } from "../types/shared.js";

export async function readActivity(limit: number, days: number): Promise<ActivityItem[]> {
  const sinceIso = new Date(Date.now() - Math.max(days, 0) * 24 * 60 * 60 * 1000).toISOString();
  const commits = await gitLogSinceForActivity(getDataRoot(), sinceIso);

  const items: ActivityItem[] = [];
  for (const commit of commits) {
    if (!commit.proposalId) continue;

    const metaPath = path.join(getProposalsCommittedRoot(), commit.proposalId, "meta.json");
    const rawMeta = await readFileIfExists(metaPath);
    if (rawMeta === null) continue;

    const proposal = decodeProposal(parseJson(rawMeta), "committed");
    if (proposal.status !== "committed") continue;

    const sections: SectionTargetRef[] = [];
    for (const s of proposal.sections) {
      const docPath = DocPath.coerce(s.stored_doc_path);
      if (!docPath) continue;
      sections.push({
        doc_path: docPath,
        heading_path: s.heading_path,
      });
    }

    const documentPaths: string[] = [];
    for (const t of proposal.targets) {
      if (t.kind !== "document") continue;
      const docPath = DocPath.coerce(t.stored_doc_path);
      if (!docPath) continue;
      documentPaths.push(docPath);
    }

    items.push({
      id: proposal.id,
      timestamp: commit.landedAtIso,
      opened_at: proposal.created_at,
      landed_at: commit.landedAtIso,
      writer_id: proposal.writer.id,
      writer_type: proposal.writer.type,
      writer_display_name: proposal.writer.displayName,
      commit_sha: proposal.committed_head || "",
      sections,
      document_paths: documentPaths,
      intent: proposal.intent,
    });

    if (items.length >= limit) break;
  }

  return items;
}
