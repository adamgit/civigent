import type { AnyProposal } from "../types/shared.js";
import type { ProposalTimelineEntry } from "../components/coordination/ProposalTimeline";

export interface DiffProposalsResult {
  entries: ProposalTimelineEntry[];
  nextMap: Map<string, { status: string }>;
  nextIdSeed: number;
}

/**
 * Pure diff between a previous proposal status snapshot and the current list.
 * Produces "created" entries for proposals not in `prevMap`, and "status_changed"
 * entries for proposals whose status differs from the snapshot. Does not track
 * removals (proposals that disappear from `newProposals` produce no entry).
 *
 * IDs are assigned monotonically starting from `nextIdSeed + 1`. The returned
 * `nextIdSeed` equals the input seed plus the number of entries produced.
 *
 * The returned `nextMap` reflects the current `newProposals` only — stale entries
 * from `prevMap` are not preserved.
 */
export function diffProposalsForTimeline(
  prevMap: Map<string, { status: string }>,
  newProposals: AnyProposal[],
  nowMs: number,
  nextIdSeed: number,
): DiffProposalsResult {
  const entries: ProposalTimelineEntry[] = [];
  let idSeed = nextIdSeed;
  for (const p of newProposals) {
    const prev = prevMap.get(p.id);
    if (!prev) {
      idSeed += 1;
      entries.push({
        id: idSeed,
        timestamp: nowMs,
        proposal_id: p.id,
        writer_id: p.writer.id,
        writer_display_name: p.writer.displayName,
        writer_kind: p.writer.type,
        event: "created",
        to_status: p.status,
        intent: p.intent,
      });
    } else if (prev.status !== p.status) {
      idSeed += 1;
      entries.push({
        id: idSeed,
        timestamp: nowMs,
        proposal_id: p.id,
        writer_id: p.writer.id,
        writer_display_name: p.writer.displayName,
        writer_kind: p.writer.type,
        event: "status_changed",
        from_status: prev.status,
        to_status: p.status,
      });
    }
  }
  const nextMap = new Map<string, { status: string }>(
    newProposals.map((p) => [p.id, { status: p.status }]),
  );
  return { entries, nextMap, nextIdSeed: idSeed };
}
