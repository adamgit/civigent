import { getAdminConfig } from "../admin-config.js";

/**
 * Compute the human-involvement score for a section based on time
 * since last human activity.
 *
 * involvement(t) = 1 / (1 + (t / midpoint) ^ steepness)
 *
 * - t = seconds since last human activity
 * - midpoint and steepness come from the admin-selected involvement preset
 * - Returns 0-1 where higher = more recent human involvement
 * - Score of 1.0 when a live CRDT session exists (hard block)
 * - Justification reduces the score by a fixed 0.1
 * - Threshold at 0.5 = accept/block boundary
 */

export const INVOLVEMENT_THRESHOLD = 0.5;
export const JUSTIFICATION_REDUCTION = 0.1;
export const AGGREGATE_IMPACT_THRESHOLD = 2.5;

export interface HumanInvolvementInput {
  secondsSinceLastHumanActivity: number | null;
  hasJustification: boolean;
}

export interface HumanInvolvementResult {
  score: number;
  blocked: boolean;
  reason?: string;
}

export function computeHumanInvolvementScore(
  secondsSinceLastActivity: number | null,
  midpointSeconds: number,
  steepness: number,
): number {
  if (secondsSinceLastActivity == null || secondsSinceLastActivity < 0) {
    return 0;
  }
  if (secondsSinceLastActivity === 0) {
    return 1;
  }
  return 1 / (1 + Math.pow(secondsSinceLastActivity / midpointSeconds, steepness));
}

export function evaluateSectionHumanInvolvement(input: HumanInvolvementInput): HumanInvolvementResult {
  const config = getAdminConfig();
  let score = computeHumanInvolvementScore(
    input.secondsSinceLastHumanActivity,
    config.humanInvolvement_midpoint_seconds,
    config.humanInvolvement_steepness,
  );

  if (input.hasJustification) {
    score = Math.max(0, score - JUSTIFICATION_REDUCTION);
  }

  const blocked = score >= INVOLVEMENT_THRESHOLD;
  return {
    score,
    blocked,
    reason: blocked ? "humanInvolvement_threshold" : undefined,
  };
}

export function computeAggregateImpact(sectionScores: number[]): {
  aggregate: number;
  blocked: boolean;
} {
  const aggregate = sectionScores.reduce((sum, s) => sum + s, 0);
  return {
    aggregate,
    blocked: aggregate > AGGREGATE_IMPACT_THRESHOLD,
  };
}

