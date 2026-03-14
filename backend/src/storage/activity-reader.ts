/**
 * v3 Activity Reader
 *
 * Reads activity from committed proposals (agent) and git history (human auto-commits).
 */

import { getContentRoot, getDataRoot } from "./data-root.js";
import { resolveDocPathUnderContent } from "./path-utils.js";
import { getCommitsBetween, getHeadSha } from "./git-repo.js";
import { listProposals } from "./proposal-repository.js";
import type {
  ActivityItem,
  ChangesSinceResponse,
  Proposal,
  SectionTargetRef,
} from "../types/shared.js";

async function readCommittedProposals(): Promise<Proposal[]> {
  const proposals = await listProposals("committed");
  // Sort by created_at descending
  proposals.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return proposals;
}

export async function readActivity(limit: number, days: number): Promise<ActivityItem[]> {
  const proposals = await readCommittedProposals();
  const now = Date.now();
  const maxAgeMs = Math.max(days, 0) * 24 * 60 * 60 * 1000;

  const items: ActivityItem[] = [];
  for (const proposal of proposals) {
    const age = now - new Date(proposal.created_at).getTime();
    if (age > maxAgeMs) continue;

    const sections: SectionTargetRef[] = proposal.sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: s.heading_path,
    }));

    items.push({
      id: proposal.id,
      timestamp: proposal.created_at,
      source: "agent_proposal",
      writer_id: proposal.writer.id,
      writer_type: proposal.writer.type,
      writer_display_name: proposal.writer.displayName,
      commit_sha: proposal.committed_head || "",
      sections,
      intent: proposal.intent,
    });

    if (items.length >= limit) break;
  }

  return items;
}

export async function readChangesSince(docPath: string, afterHead?: string): Promise<ChangesSinceResponse> {
  resolveDocPathUnderContent(getContentRoot(), docPath);
  const dataRoot = getDataRoot();
  let currentSha: string;
  try {
    currentSha = await getHeadSha(dataRoot);
  } catch {
    return { since_sha: afterHead || "", current_sha: "", changed: false, changed_sections: [] };
  }

  if (!afterHead) {
    return { since_sha: "", current_sha: currentSha, changed: false, changed_sections: [] };
  }

  let allowedShas: Set<string>;
  try {
    allowedShas = await getCommitsBetween(dataRoot, afterHead);
  } catch {
    return { since_sha: afterHead, current_sha: currentSha, changed: false, changed_sections: [] };
  }

  if (allowedShas.size === 0) {
    return { since_sha: afterHead, current_sha: currentSha, changed: false, changed_sections: [] };
  }

  const proposals = await readCommittedProposals();
  const changedSections: SectionTargetRef[] = [];

  for (const proposal of proposals) {
    if (!proposal.committed_head || !allowedShas.has(proposal.committed_head)) continue;
    for (const section of proposal.sections) {
      if (section.doc_path !== docPath) continue;
      changedSections.push({
        doc_path: section.doc_path,
        heading_path: section.heading_path,
      });
    }
  }

  return {
    since_sha: afterHead,
    current_sha: currentSha,
    changed: changedSections.length > 0,
    changed_sections: changedSections,
  };
}
