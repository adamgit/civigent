import { describe, it, expect } from "vitest";
import {
  uniquePreserveOrder,
  mergeKnownDocPaths,
  filterDocsByQuery,
} from "../../services/known-docs-merge";
import type { ActivityItem, AnyProposal } from "../../types/shared.js";

function makeActivity(sections: { doc_path: string }[]): ActivityItem {
  return {
    id: "act-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    writer_id: "u",
    writer_type: "human",
    writer_display_name: "U",
    commit_sha: "abc",
    sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: ["H"] })),
  };
}

function makeProposal(sections: { doc_path: string }[]): AnyProposal {
  return {
    id: "p-1",
    kind: "human_reservation",
    writer: { id: "u", type: "human", display_name: "U" },
    intent: "x",
    status: "draft",
    sections: sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: ["H"],
      content: "",
    })),
    created_at: "2026-01-01T00:00:00.000Z",
    evaluation: null,
  } as unknown as AnyProposal;
}

describe("uniquePreserveOrder", () => {
  it("returns empty for empty input", () => {
    expect(uniquePreserveOrder([])).toEqual([]);
  });

  it("returns single value", () => {
    expect(uniquePreserveOrder(["a.md"])).toEqual(["a.md"]);
  });

  it("dedupes all-duplicates input", () => {
    expect(uniquePreserveOrder(["a.md", "a.md", "a.md"])).toEqual(["a.md"]);
  });

  it("dedupes mixed input preserving first-seen order", () => {
    expect(uniquePreserveOrder(["a.md", "b.md", "a.md", "c.md", "b.md"])).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  it("drops whitespace-only entries", () => {
    expect(uniquePreserveOrder(["a.md", "  ", "", "b.md"])).toEqual(["a.md", "b.md"]);
  });

  it("trims leading/trailing whitespace and then dedupes", () => {
    expect(uniquePreserveOrder(["  a.md  ", "a.md"])).toEqual(["a.md"]);
  });
});

describe("mergeKnownDocPaths", () => {
  it("returns empty when all sources are empty", () => {
    expect(mergeKnownDocPaths([], [], [])).toEqual([]);
  });

  it("returns only localDocs when activity and proposals are empty", () => {
    expect(mergeKnownDocPaths(["a.md", "b.md"], [], [])).toEqual(["a.md", "b.md"]);
  });

  it("returns only activity docs when localDocs and proposals are empty", () => {
    const activity = [makeActivity([{ doc_path: "a.md" }])];
    expect(mergeKnownDocPaths([], activity, [])).toEqual(["a.md"]);
  });

  it("returns only proposal docs when localDocs and activity are empty", () => {
    const proposals = [makeProposal([{ doc_path: "a.md" }])];
    expect(mergeKnownDocPaths([], [], proposals)).toEqual(["a.md"]);
  });

  it("local order wins on overlap with activity", () => {
    const activity = [makeActivity([{ doc_path: "a.md" }])];
    expect(mergeKnownDocPaths(["b.md", "a.md"], activity, [])).toEqual(["b.md", "a.md"]);
  });

  it("activity item with multiple sections contributes each doc_path", () => {
    const activity = [makeActivity([{ doc_path: "a.md" }, { doc_path: "b.md" }])];
    expect(mergeKnownDocPaths([], activity, [])).toEqual(["a.md", "b.md"]);
  });

  it("proposal with multiple sections contributes each doc_path", () => {
    const proposals = [makeProposal([{ doc_path: "a.md" }, { doc_path: "b.md" }])];
    expect(mergeKnownDocPaths([], [], proposals)).toEqual(["a.md", "b.md"]);
  });

  it("all three sources contributing same path yields single result", () => {
    const activity = [makeActivity([{ doc_path: "a.md" }])];
    const proposals = [makeProposal([{ doc_path: "a.md" }])];
    expect(mergeKnownDocPaths(["a.md"], activity, proposals)).toEqual(["a.md"]);
  });
});

describe("filterDocsByQuery", () => {
  it("returns input when query is empty", () => {
    const docs = ["a.md", "b.md"];
    expect(filterDocsByQuery(docs, "")).toEqual(docs);
  });

  it("returns empty when no match", () => {
    expect(filterDocsByQuery(["a.md", "b.md"], "z")).toEqual([]);
  });

  it("matches partial substring", () => {
    expect(filterDocsByQuery(["ops/strategy.md", "team/roles.md"], "strat")).toEqual(["ops/strategy.md"]);
  });

  it("matches case-insensitively", () => {
    expect(filterDocsByQuery(["ops/Strategy.md"], "strat")).toEqual(["ops/Strategy.md"]);
    expect(filterDocsByQuery(["ops/strategy.md"], "STRAT")).toEqual(["ops/strategy.md"]);
  });

  it("trims leading/trailing whitespace from query", () => {
    expect(filterDocsByQuery(["a.md"], "  a  ")).toEqual(["a.md"]);
  });

  it("treats special characters as literal substrings", () => {
    expect(filterDocsByQuery(["ops.foo.md", "ops_foo.md"], "ops.f")).toEqual(["ops.foo.md"]);
  });
});
