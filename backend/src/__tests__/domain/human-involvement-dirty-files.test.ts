import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getDirtySessionFileSet,
  computeHumanInvolvementScore,
  evaluateSectionHumanInvolvement,
  INVOLVEMENT_THRESHOLD,
  JUSTIFICATION_REDUCTION,
} from "../../domain/humanInvolvement.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("human-involvement dirty files", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("getDirtySessionFileSet returns a Set (possibly empty) for a document path", async () => {
    const result = await getDirtySessionFileSet(SAMPLE_DOC_PATH);
    expect(result).toBeInstanceOf(Set);
  });

  it("getDirtySessionFileSet returns empty Set when no session overlay exists", async () => {
    const result = await getDirtySessionFileSet("nonexistent-doc.md");
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });
});

describe("computeHumanInvolvementScore", () => {
  it("returns 0 for null seconds", () => {
    expect(computeHumanInvolvementScore(null, 300, 2)).toBe(0);
  });

  it("returns 0 for negative seconds", () => {
    expect(computeHumanInvolvementScore(-10, 300, 2)).toBe(0);
  });

  it("returns 1 for zero seconds (just edited)", () => {
    expect(computeHumanInvolvementScore(0, 300, 2)).toBe(1);
  });

  it("returns value near 0.5 at the midpoint", () => {
    // At midpoint: 1 / (1 + (midpoint/midpoint)^steepness) = 1 / (1 + 1) = 0.5
    const score = computeHumanInvolvementScore(300, 300, 2);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("returns high score for recent activity", () => {
    const score = computeHumanInvolvementScore(10, 300, 2);
    expect(score).toBeGreaterThan(0.9);
  });

  it("returns low score for old activity", () => {
    const score = computeHumanInvolvementScore(3600, 300, 2);
    expect(score).toBeLessThan(0.1);
  });

  it("higher steepness makes the curve sharper", () => {
    const steep1 = computeHumanInvolvementScore(200, 300, 1);
    const steep4 = computeHumanInvolvementScore(200, 300, 4);
    // Higher steepness should produce a higher score at the same point
    // (because the dropoff is steeper around the midpoint, so 200 < 300 stays high)
    expect(steep4).toBeGreaterThan(steep1);
  });
});

describe("evaluateSectionHumanInvolvement", () => {
  it("returns score=1.0 and blocked for active CRDT session without pulse data", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: null,
      crdtSessionActive: true,
      hasJustification: false,
    });

    expect(result.score).toBe(1.0);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("live_session");
  });

  it("uses graduated level when CRDT session active and pulse data available", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: null,
      crdtSessionActive: true,
      hasJustification: false,
      graduatedLevel: 0.3,
    });

    expect(result.score).toBe(0.3);
    expect(result.blocked).toBe(false);
  });

  it("graduated level above threshold blocks", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: null,
      crdtSessionActive: true,
      hasJustification: false,
      graduatedLevel: 0.8,
    });

    expect(result.score).toBe(0.8);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("live_session");
  });

  it("justification reduces score by JUSTIFICATION_REDUCTION", () => {
    const withoutJustification = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 100,
      crdtSessionActive: false,
      hasJustification: false,
    });

    const withJustification = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 100,
      crdtSessionActive: false,
      hasJustification: true,
    });

    expect(withJustification.score).toBeCloseTo(
      Math.max(0, withoutJustification.score - JUSTIFICATION_REDUCTION),
      5,
    );
  });

  it("score below threshold is not blocked", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 10000,
      crdtSessionActive: false,
      hasJustification: false,
    });

    expect(result.score).toBeLessThan(INVOLVEMENT_THRESHOLD);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("score at or above threshold is blocked with humanInvolvement_threshold reason", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 0,
      crdtSessionActive: false,
      hasJustification: false,
    });

    expect(result.score).toBeGreaterThanOrEqual(INVOLVEMENT_THRESHOLD);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("humanInvolvement_threshold");
  });

  it("score never goes below 0 even with justification", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: null,
      crdtSessionActive: false,
      hasJustification: true,
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
