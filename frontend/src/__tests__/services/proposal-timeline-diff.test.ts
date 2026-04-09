import { describe, it, expect } from "vitest";
import { diffProposalsForTimeline } from "../../services/proposal-timeline-diff";
import type { AnyProposal, ProposalStatus } from "../../types/shared.js";

function makeProposal(opts: { id: string; status: ProposalStatus; intent?: string }): AnyProposal {
  return {
    id: opts.id,
    status: opts.status,
    intent: opts.intent ?? "intent",
    kind: "agent_write",
    writer: { id: "agent-1", type: "agent", display_name: "Agent A", displayName: "Agent A" },
    sections: [],
    created_at: "2026-01-01T00:00:00.000Z",
    evaluation: null,
  } as unknown as AnyProposal;
}

const NOW = 1700000000000;

describe("diffProposalsForTimeline", () => {
  it("empty prevMap + empty newProposals → no entries, empty nextMap, same idSeed", () => {
    const result = diffProposalsForTimeline(new Map(), [], NOW, 5);
    expect(result.entries).toEqual([]);
    expect(result.nextMap.size).toBe(0);
    expect(result.nextIdSeed).toBe(5);
  });

  it("empty prevMap + N new proposals → N 'created' entries with monotonic ids starting after seed", () => {
    const proposals: AnyProposal[] = [
      makeProposal({ id: "p1", status: "draft", intent: "first" }),
      makeProposal({ id: "p2", status: "draft", intent: "second" }),
      makeProposal({ id: "p3", status: "committed", intent: "third" }),
    ];
    const result = diffProposalsForTimeline(new Map(), proposals, NOW, 10);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.id)).toEqual([11, 12, 13]);
    expect(result.entries.map((e) => e.event)).toEqual(["created", "created", "created"]);
    expect(result.entries.map((e) => e.proposal_id)).toEqual(["p1", "p2", "p3"]);
    expect(result.entries.map((e) => e.intent)).toEqual(["first", "second", "third"]);
    expect(result.nextIdSeed).toBe(13);
  });

  it("unchanged proposal in newProposals produces no entry", () => {
    const prevMap = new Map([["p1", { status: "draft" }]]);
    const proposals: AnyProposal[] = [makeProposal({ id: "p1", status: "draft" })];
    const result = diffProposalsForTimeline(prevMap, proposals, NOW, 0);
    expect(result.entries).toEqual([]);
    expect(result.nextIdSeed).toBe(0);
  });

  it("status change in newProposals produces 'status_changed' entry with from/to", () => {
    const prevMap = new Map([["p1", { status: "draft" }]]);
    const proposals: AnyProposal[] = [makeProposal({ id: "p1", status: "committed" })];
    const result = diffProposalsForTimeline(prevMap, proposals, NOW, 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].event).toBe("status_changed");
    expect(result.entries[0].from_status).toBe("draft");
    expect(result.entries[0].to_status).toBe("committed");
    expect(result.entries[0].id).toBe(1);
  });

  it("removed proposal (in prevMap, not in newProposals) produces no entry", () => {
    const prevMap = new Map([
      ["p1", { status: "draft" }],
      ["p2", { status: "draft" }],
    ]);
    const proposals: AnyProposal[] = [makeProposal({ id: "p1", status: "draft" })];
    const result = diffProposalsForTimeline(prevMap, proposals, NOW, 0);
    expect(result.entries).toEqual([]);
  });

  it("mixed scenario: created + changed + unchanged in iteration order", () => {
    const prevMap = new Map([
      ["p-old", { status: "draft" }],
      ["p-changed", { status: "draft" }],
    ]);
    const proposals: AnyProposal[] = [
      makeProposal({ id: "p-old", status: "draft" }), // unchanged
      makeProposal({ id: "p-changed", status: "committed" }), // changed
      makeProposal({ id: "p-new", status: "draft" }), // created
    ];
    const result = diffProposalsForTimeline(prevMap, proposals, NOW, 0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].event).toBe("status_changed");
    expect(result.entries[0].proposal_id).toBe("p-changed");
    expect(result.entries[1].event).toBe("created");
    expect(result.entries[1].proposal_id).toBe("p-new");
  });

  it("nextIdSeed equals input + entries.length", () => {
    const proposals: AnyProposal[] = [
      makeProposal({ id: "p1", status: "draft" }),
      makeProposal({ id: "p2", status: "draft" }),
    ];
    const result = diffProposalsForTimeline(new Map(), proposals, NOW, 100);
    expect(result.nextIdSeed).toBe(102);
    expect(result.entries.length).toBe(2);
  });

  it("nextMap contains only proposals from newProposals (drops stale prevMap entries)", () => {
    const prevMap = new Map([
      ["p-old", { status: "draft" }],
      ["p-stale", { status: "draft" }],
    ]);
    const proposals: AnyProposal[] = [
      makeProposal({ id: "p-old", status: "committed" }),
      makeProposal({ id: "p-new", status: "draft" }),
    ];
    const result = diffProposalsForTimeline(prevMap, proposals, NOW, 0);
    expect(result.nextMap.size).toBe(2);
    expect(result.nextMap.has("p-old")).toBe(true);
    expect(result.nextMap.has("p-new")).toBe(true);
    expect(result.nextMap.has("p-stale")).toBe(false);
    expect(result.nextMap.get("p-old")?.status).toBe("committed");
  });

  it("entries' timestamps equal nowMs", () => {
    const proposals: AnyProposal[] = [makeProposal({ id: "p1", status: "draft" })];
    const result = diffProposalsForTimeline(new Map(), proposals, 9999, 0);
    expect(result.entries[0].timestamp).toBe(9999);
  });
});
