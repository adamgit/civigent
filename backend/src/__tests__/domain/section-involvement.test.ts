import { describe, it, expect } from "vitest";
import { SectionGuard, type SectionInput } from "../../domain/section-guard.js";
import type { SectionCommitInfo } from "../../storage/section-activity.js";
import type { HumanProposalLockIndex } from "../../domain/section-presence.js";

describe("section-human-involvement (via SectionGuard.evaluateWithPrefetch)", () => {
  const EMPTY_DIRTY = new Set<string>();
  const EMPTY_COMMITS = new Map<string, SectionCommitInfo>();
  const EMPTY_LOCKS: HumanProposalLockIndex = new Map();

  it("section with no history returns zero human-involvement score", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["SomeSection"] };
    const result = SectionGuard.evaluateWithPrefetch(section, EMPTY_DIRTY, EMPTY_COMMITS, EMPTY_LOCKS);

    expect(result.humanInvolvement_score).toBe(0);
    expect(result.blocked).toBe(false);
  });

  it("result includes humanInvolvement_score and blocked", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["AnotherSection"] };
    const result = SectionGuard.evaluateWithPrefetch(section, EMPTY_DIRTY, EMPTY_COMMITS, EMPTY_LOCKS);

    expect(result).toHaveProperty("humanInvolvement_score");
    expect(result).toHaveProperty("blocked");
    expect(typeof result.humanInvolvement_score).toBe("number");
    expect(typeof result.blocked).toBe("boolean");
  });

  it("dirty file set makes section blocked with score 1.0", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["SomeSection"] };
    const dirtySet = new Set(["SomeSection"]);
    const result = SectionGuard.evaluateWithPrefetch(section, dirtySet, EMPTY_COMMITS, EMPTY_LOCKS);

    expect(result.humanInvolvement_score).toBe(1.0);
    expect(result.blocked).toBe(true);
  });

  it("very recent git commit produces high human-involvement score", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["RecentSection"] };
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("RecentSection", {
      sha: "abc123",
      timestampMs: Date.now() - 1000, // 1 second ago
      authorEmail: "test@test.local",
    });

    const result = SectionGuard.evaluateWithPrefetch(section, EMPTY_DIRTY, commitByHeading, EMPTY_LOCKS);

    expect(result.humanInvolvement_score).toBeGreaterThan(0.5);
    expect(result.blocked).toBe(true);
  });

  it("old git commit produces low human-involvement score", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["OldSection"] };
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("OldSection", {
      sha: "def456",
      timestampMs: Date.now() - 7 * 24 * 3600 * 1000, // 7 days ago
      authorEmail: "test@test.local",
    });

    const result = SectionGuard.evaluateWithPrefetch(section, EMPTY_DIRTY, commitByHeading, EMPTY_LOCKS);

    expect(result.humanInvolvement_score).toBeLessThan(0.5);
    expect(result.blocked).toBe(false);
  });

  it("humanInvolvement_score is always between 0 and 1", () => {
    // No history
    const s1: SectionInput = { doc_path: "doc.md", heading_path: ["A"] };
    const r1 = SectionGuard.evaluateWithPrefetch(s1, EMPTY_DIRTY, EMPTY_COMMITS, EMPTY_LOCKS);
    expect(r1.humanInvolvement_score).toBeGreaterThanOrEqual(0);
    expect(r1.humanInvolvement_score).toBeLessThanOrEqual(1);

    // Very recent commit
    const s2: SectionInput = { doc_path: "doc.md", heading_path: ["B"] };
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("B", {
      sha: "abc",
      timestampMs: Date.now() - 100,
      authorEmail: "test@test.local",
    });
    const r2 = SectionGuard.evaluateWithPrefetch(s2, EMPTY_DIRTY, commitByHeading, EMPTY_LOCKS);
    expect(r2.humanInvolvement_score).toBeGreaterThanOrEqual(0);
    expect(r2.humanInvolvement_score).toBeLessThanOrEqual(1);
  });

  it("human proposal lock marks section as blocked with score 1.0", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["Locked"] };
    const humanProposalLockIndex: HumanProposalLockIndex = new Map([
      ["doc.md::Locked", { writerId: "human-1", writerDisplayName: "Human" }],
    ]);

    const result = SectionGuard.evaluateWithPrefetch(section, EMPTY_DIRTY, EMPTY_COMMITS, humanProposalLockIndex);

    expect(result.humanInvolvement_score).toBe(1.0);
    expect(result.blocked).toBe(true);
  });

  it("nested heading path joins with >> for key lookups", () => {
    const section: SectionInput = { doc_path: "doc.md", heading_path: ["Parent", "Child"] };
    const commitByHeading = new Map<string, SectionCommitInfo>();
    commitByHeading.set("Parent>>Child", {
      sha: "xyz",
      timestampMs: Date.now() - 500,
      authorEmail: "test@test.local",
    });

    const result = SectionGuard.evaluateWithPrefetch(section, EMPTY_DIRTY, commitByHeading, EMPTY_LOCKS);

    expect(result.humanInvolvement_score).toBeGreaterThan(0);
  });
});
