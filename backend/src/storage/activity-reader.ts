/**
 * v3 Activity Reader
 *
 * Reads activity from committed proposals (agent) and git history (human auto-commits).
 */

import { listCommittedProposals } from "./proposal-repository.js";
import type {
  ActivityItem,
  CommittedProposalDomain,
  SectionTargetRef,
} from "../types/shared.js";

async function readCommittedProposals(): Promise<CommittedProposalDomain[]> {
  const proposals = await listCommittedProposals();
  const committed = proposals.filter(
    (p): p is CommittedProposalDomain => p.status === "committed",
  );
  // Sort by created_at descending
  committed.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return committed;
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
