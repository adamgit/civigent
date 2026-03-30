import { describe, it, expect } from "vitest";
import {
  computeHumanInvolvementScore,
  evaluateSectionHumanInvolvement,
  INVOLVEMENT_THRESHOLD,
  JUSTIFICATION_REDUCTION,
} from "../../domain/humanInvolvement.js";

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
  it("justification reduces score by JUSTIFICATION_REDUCTION", () => {
    const withoutJustification = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 100,
      hasJustification: false,
    });

    const withJustification = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 100,
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
      hasJustification: false,
    });

    expect(result.score).toBeLessThan(INVOLVEMENT_THRESHOLD);
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("score at or above threshold is blocked with humanInvolvement_threshold reason", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: 0,
      hasJustification: false,
    });

    expect(result.score).toBeGreaterThanOrEqual(INVOLVEMENT_THRESHOLD);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("humanInvolvement_threshold");
  });

  it("score never goes below 0 even with justification", () => {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: null,
      hasJustification: true,
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
