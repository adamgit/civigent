/**
 * Session-local draft memory — the ONLY implicit draft affinity MCP tools may
 * use (task 708). Proposal files never carry MCP session identity; the list of
 * drafts a session created lives on the in-memory `McpSession` object and
 * disappears with it (TTL / DELETE / process restart). Losing the memory never
 * loses proposals: they remain durable authored artifacts reachable by explicit
 * `proposal_id` and writer-scoped listing.
 */

import type { McpSession } from "./tool-registry.js";
import { readProposal, ProposalNotFoundError } from "../storage/proposal-repository.js";
import type { AnyProposal } from "../types/shared.js";

/** Record a draft created by this session (most recent last). */
export function rememberSessionDraft(session: McpSession, proposalId: string): void {
  const ids = session.draftIds ?? (session.draftIds = []);
  const existing = ids.indexOf(proposalId);
  if (existing !== -1) ids.splice(existing, 1);
  ids.push(proposalId);
}

/** Drop a proposal from this session's draft memory (published/withdrawn). */
export function forgetSessionDraft(session: McpSession, proposalId: string): void {
  if (!session.draftIds) return;
  const index = session.draftIds.indexOf(proposalId);
  if (index !== -1) session.draftIds.splice(index, 1);
}

/**
 * Pop the most recent proposal remembered by THIS session that is still a
 * `draft` owned by `writerId`. Remembered ids that no longer resolve to such a
 * draft (published, withdrawn, deleted, or a different writer) are pruned as
 * they are passed over. Returns null when the session remembers no live draft —
 * callers must NOT fall back to a writer-wide search: another session's draft
 * is never an implicit target.
 */
export async function takeCurrentSessionDraft(
  session: McpSession,
  writerId: string,
): Promise<AnyProposal | null> {
  const ids = session.draftIds;
  if (!ids) return null;
  while (ids.length > 0) {
    const id = ids[ids.length - 1]!;
    let proposal: AnyProposal;
    try {
      proposal = await readProposal(id);
    } catch (error) {
      if (error instanceof ProposalNotFoundError) {
        ids.pop();
        continue;
      }
      throw error;
    }
    if (proposal.status !== "draft" || proposal.writer.id !== writerId) {
      ids.pop();
      continue;
    }
    ids.pop();
    return proposal;
  }
  return null;
}
