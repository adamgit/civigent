import { describe, it, expect } from "vitest";
import { evaluateSectionHumanInvolvementBulk } from "../../domain/section-human-involvement.js";
import type { SectionCommitInfo } from "../../storage/section-activity.js";

describe("section-human-involvement", () => {
  it("section with no history returns zero human-involvement score", () => {
    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["SomeSection"],
      new Set(),
      new Map(),
    );

    expect(result.humanInvolvement_score).toBe(0);
    expect(result.crdt_session_active).toBe(false);
  });

  it("result includes humanInvolvement_score, crdt_session_active, and optional block_reason", () => {
    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["AnotherSection"],
      new Set(),
      new Map(),
    );

    expect(result).toHaveProperty("humanInvolvement_score");
    expect(result).toHaveProperty("crdt_session_active");
    expect(typeof result.humanInvolvement_score).toBe("number");
    expect(typeof result.crdt_session_active).toBe("boolean");
  });

  it("dirty file set makes section appear as active editing", () => {
    const dirtySet = new Set(["SomeSection"]);
    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["SomeSection"],
      dirtySet,
      new Map(),
    );

    // Dirty section is treated as actively edited
    expect(result.crdt_session_active).toBe(true);
    expect(result.block_reason).toBe("dirty_session_files");
  });

  it("very recent git commit produces high human-involvement score", () => {
    const now = Date.now();
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("RecentSection", {
      sha: "abc123",
      timestampMs: now - 1000, // 1 second ago
      authorEmail: "test@test.local",
    });

    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["RecentSection"],
      new Set(),
      commitByHeading,
    );

    expect(result.humanInvolvement_score).toBeGreaterThan(0.5);
    expect(result.crdt_session_active).toBe(false);
  });

  it("old git commit produces low human-involvement score", () => {
    const now = Date.now();
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("OldSection", {
      sha: "def456",
      timestampMs: now - 7 * 24 * 3600 * 1000, // 7 days ago
      authorEmail: "test@test.local",
    });

    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["OldSection"],
      new Set(),
      commitByHeading,
    );

    expect(result.humanInvolvement_score).toBeLessThan(0.5);
    expect(result.crdt_session_active).toBe(false);
  });

  it("humanInvolvement_score is always between 0 and 1", () => {
    // No history
    const r1 = evaluateSectionHumanInvolvementBulk("doc.md", ["A"], new Set(), new Map());
    expect(r1.humanInvolvement_score).toBeGreaterThanOrEqual(0);
    expect(r1.humanInvolvement_score).toBeLessThanOrEqual(1);

    // Very recent commit
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("B", {
      sha: "abc",
      timestampMs: Date.now() - 100,
      authorEmail: "test@test.local",
    });
    const r2 = evaluateSectionHumanInvolvementBulk("doc.md", ["B"], new Set(), commitByHeading);
    expect(r2.humanInvolvement_score).toBeGreaterThanOrEqual(0);
    expect(r2.humanInvolvement_score).toBeLessThanOrEqual(1);
  });

  it("human proposal lock marks section as actively edited", () => {
    const humanProposalLockIndex = new Map([
      ["doc.md::Locked", { writerId: "human-1", writerDisplayName: "Human" }],
    ]);

    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["Locked"],
      new Set(),
      new Map(),
      humanProposalLockIndex,
    );

    expect(result.crdt_session_active).toBe(true);
    expect(result.block_reason).toBe("human_proposal");
  });

  it("nested heading path joins with >> for key lookups", () => {
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("Parent>>Child", {
      sha: "xyz",
      timestampMs: Date.now() - 500,
      authorEmail: "test@test.local",
    });

    const result = evaluateSectionHumanInvolvementBulk(
      "doc.md",
      ["Parent", "Child"],
      new Set(),
      commitByHeading,
    );

    // Should find the commit info via the joined key
    expect(result.humanInvolvement_score).toBeGreaterThan(0);
  });
});
