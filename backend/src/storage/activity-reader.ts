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
  CommittedProposalDomain,
  SectionTargetRef,
} from "../types/shared.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return String(error).toLowerCase();
}

function isNoHistoryHeadError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("does not have any commits") ||
    message.includes("your current branch") ||
    message.includes("not a valid object name head") ||
    (message.includes("unknown revision") && message.includes("head")) ||
    (message.includes("ambiguous argument") && message.includes("head"))
  );
}

function isUnknownShaError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("unknown revision") ||
    message.includes("bad revision") ||
    message.includes("bad object") ||
    message.includes("not a valid object name") ||
    message.includes("ambiguous argument") ||
    message.includes("invalid revision range")
  );
}

async function readCommittedProposals(): Promise<CommittedProposalDomain[]> {
  const proposals = await listProposals("committed");
  // listProposals("committed") only returns committed proposals; narrow the type.
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

export async function readChangesSince(docPath: string, afterHead?: string): Promise<ChangesSinceResponse> {
  resolveDocPathUnderContent(getContentRoot(), docPath);
  const dataRoot = getDataRoot();
  let currentSha: string;
  try {
    currentSha = await getHeadSha(dataRoot);
  } catch (error) {
    if (!isNoHistoryHeadError(error)) throw error;
    return { since_sha: afterHead || "", current_sha: "", changed: false, changed_sections: [] };
  }

  if (!afterHead) {
    return { since_sha: "", current_sha: currentSha, changed: false, changed_sections: [] };
  }

  let allowedShas: Set<string>;
  try {
    allowedShas = await getCommitsBetween(dataRoot, afterHead);
  } catch (error) {
    if (!isUnknownShaError(error)) throw error;
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
