import { describe, it, expect } from "vitest";
import { filterProposals } from "../../services/proposal-filter";
import type { AnyProposal, ProposalStatus, WriterType } from "../../types/shared.js";

function makeProposal(opts: {
  id: string;
  intent?: string;
  status: ProposalStatus;
  writerType?: WriterType;
}): AnyProposal {
  return {
    id: opts.id,
    intent: opts.intent ?? "intent",
    status: opts.status,
    kind: opts.writerType === "human" ? "human_reservation" : "agent_write",
    writer: {
      id: `${opts.writerType ?? "agent"}-1`,
      type: opts.writerType ?? "agent",
      display_name: "W",
    },
    sections: [],
    created_at: "2026-01-01T00:00:00.000Z",
    evaluation: null,
  } as unknown as AnyProposal;
}

const allStatuses: AnyProposal[] = [
  makeProposal({ id: "p-draft", status: "draft" }),
  makeProposal({ id: "p-inprogress", status: "inprogress" }),
  makeProposal({ id: "p-committing", status: "committing" }),
  makeProposal({ id: "p-committed", status: "committed" }),
  makeProposal({ id: "p-withdrawn", status: "withdrawn" }),
];

describe("filterProposals - status filter", () => {
  it("'All' returns all proposals", () => {
    expect(filterProposals(allStatuses, { statusFilter: "All", writerFilter: "All writers", query: "" })).toHaveLength(5);
  });

  it("'Inflight' returns draft, inprogress, committing", () => {
    const result = filterProposals(allStatuses, { statusFilter: "Inflight", writerFilter: "All writers", query: "" });
    expect(result.map((p) => p.id).sort()).toEqual(["p-committing", "p-draft", "p-inprogress"]);
  });

  it("'Proposing' returns only draft", () => {
    const result = filterProposals(allStatuses, { statusFilter: "Proposing", writerFilter: "All writers", query: "" });
    expect(result.map((p) => p.id)).toEqual(["p-draft"]);
  });

  it("'Committed' returns only committed", () => {
    const result = filterProposals(allStatuses, { statusFilter: "Committed", writerFilter: "All writers", query: "" });
    expect(result.map((p) => p.id)).toEqual(["p-committed"]);
  });

  it("'Cancelled' returns only withdrawn", () => {
    const result = filterProposals(allStatuses, { statusFilter: "Cancelled", writerFilter: "All writers", query: "" });
    expect(result.map((p) => p.id)).toEqual(["p-withdrawn"]);
  });

  it("status filter combined with empty list yields empty", () => {
    expect(filterProposals([], { statusFilter: "Committed", writerFilter: "All writers", query: "" })).toEqual([]);
  });
});

describe("filterProposals - writer filter", () => {
  const mixed: AnyProposal[] = [
    makeProposal({ id: "h-1", status: "draft", writerType: "human" }),
    makeProposal({ id: "a-1", status: "draft", writerType: "agent" }),
    makeProposal({ id: "h-2", status: "committed", writerType: "human" }),
  ];

  it("'All writers' returns all", () => {
    expect(filterProposals(mixed, { statusFilter: "All", writerFilter: "All writers", query: "" })).toHaveLength(3);
  });

  it("'Human' returns only human writers", () => {
    const result = filterProposals(mixed, { statusFilter: "All", writerFilter: "Human", query: "" });
    expect(result.map((p) => p.id).sort()).toEqual(["h-1", "h-2"]);
  });

  it("'Agent' returns only agent writers", () => {
    const result = filterProposals(mixed, { statusFilter: "All", writerFilter: "Agent", query: "" });
    expect(result.map((p) => p.id)).toEqual(["a-1"]);
  });
});

describe("filterProposals - query filter", () => {
  const items: AnyProposal[] = [
    makeProposal({ id: "alpha-id", intent: "Update strategy doc", status: "draft" }),
    makeProposal({ id: "beta-id", intent: "Add risk section", status: "draft" }),
    makeProposal({ id: "gamma-id", intent: "Refactor overview", status: "draft" }),
  ];

  it("empty query returns input", () => {
    expect(filterProposals(items, { statusFilter: "All", writerFilter: "All writers", query: "" })).toHaveLength(3);
  });

  it("matches intent substring case-insensitively", () => {
    const result = filterProposals(items, { statusFilter: "All", writerFilter: "All writers", query: "STRAT" });
    expect(result.map((p) => p.id)).toEqual(["alpha-id"]);
  });

  it("matches id substring case-insensitively", () => {
    const result = filterProposals(items, { statusFilter: "All", writerFilter: "All writers", query: "BETA" });
    expect(result.map((p) => p.id)).toEqual(["beta-id"]);
  });

  it("trims leading/trailing whitespace from query", () => {
    const result = filterProposals(items, { statusFilter: "All", writerFilter: "All writers", query: "  strategy  " });
    expect(result.map((p) => p.id)).toEqual(["alpha-id"]);
  });

  it("no-match returns empty", () => {
    expect(filterProposals(items, { statusFilter: "All", writerFilter: "All writers", query: "zzz" })).toEqual([]);
  });

  it("query matching both id and intent yields single result per proposal", () => {
    const aliased: AnyProposal[] = [
      makeProposal({ id: "match-id", intent: "match intent", status: "draft" }),
    ];
    const result = filterProposals(aliased, { statusFilter: "All", writerFilter: "All writers", query: "match" });
    expect(result).toHaveLength(1);
  });
});

describe("filterProposals - combined filters", () => {
  const mixed: AnyProposal[] = [
    makeProposal({ id: "hd1", intent: "alpha", status: "draft", writerType: "human" }),
    makeProposal({ id: "hd2", intent: "beta", status: "draft", writerType: "human" }),
    makeProposal({ id: "ad1", intent: "alpha", status: "draft", writerType: "agent" }),
    makeProposal({ id: "hc1", intent: "alpha", status: "committed", writerType: "human" }),
  ];

  it("status + writer narrows correctly", () => {
    const result = filterProposals(mixed, { statusFilter: "Proposing", writerFilter: "Human", query: "" });
    expect(result.map((p) => p.id).sort()).toEqual(["hd1", "hd2"]);
  });

  it("all three filters together", () => {
    const result = filterProposals(mixed, { statusFilter: "Proposing", writerFilter: "Human", query: "alpha" });
    expect(result.map((p) => p.id)).toEqual(["hd1"]);
  });

  it("status filter excluding the only matching proposal yields empty", () => {
    const result = filterProposals(mixed, { statusFilter: "Cancelled", writerFilter: "Human", query: "alpha" });
    expect(result).toEqual([]);
  });
});
