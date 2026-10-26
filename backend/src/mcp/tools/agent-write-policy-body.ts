/**
 * Shared shaper turning an agent-write-policy result into an MCP response body.
 *
 * Surfaces the policy's prose `message`s (top-level + per-target) instead of
 * bare reason codes / enums. Area M owns the final verbose, action-oriented
 * wording; this is the interim shared shape every MCP agent surface renders.
 */

import type { HumanInvolvementPolicyResult } from "../../types/shared.js";

type PolicyTarget = HumanInvolvementPolicyResult["targets"][number];

interface TouchedSection {
  doc_path: string;
  heading_path: readonly string[];
}

function targetEntry(t: PolicyTarget) {
  return {
    kind: t.target.kind,
    doc_path: t.target.doc_path,
    heading_path: t.target.kind === "section" ? t.target.heading_path : undefined,
    can_write: t.canWrite,
    message: t.message,
  };
}

function isTouched(t: PolicyTarget, touched: readonly TouchedSection[]): boolean {
  if (t.target.kind !== "section") return false;
  const { doc_path, heading_path } = t.target;
  return touched.some(
    (s) =>
      s.doc_path === doc_path
      && s.heading_path.length === heading_path.length
      && s.heading_path.every((h, i) => h === heading_path[i]),
  );
}

function unlistedBlockedNote(count: number): Record<string, string> {
  if (count === 0) return {};
  return {
    unlisted_blocked_note:
      `${count} blocked target${count === 1 ? " is" : "s are"} not listed in this response. ` +
      "Call read_proposal to see the verdict for every target in the proposal.",
  };
}

/** Full per-target body — every target in the proposal. */
export function agentWritePolicyToolBody(result: HumanInvolvementPolicyResult) {
  return {
    can_write: result.canWrite,
    message: result.message,
    targets: result.targets.map(targetEntry),
  };
}

/**
 * Body for a call that mutates a proposal. Lists only the targets the call
 * itself named, so the response size does not grow with the proposal.
 */
export function agentWritePolicyWriteBody(
  result: HumanInvolvementPolicyResult,
  touched: readonly TouchedSection[],
) {
  const listed = result.targets.filter((t) => isTouched(t, touched));
  const blockedCount = result.targets.filter((t) => !t.canWrite).length;
  const listedBlockedCount = listed.filter((t) => !t.canWrite).length;
  return {
    can_write: result.canWrite,
    message: result.message,
    target_count: result.targets.length,
    blocked_target_count: blockedCount,
    targets: listed.map(targetEntry),
    ...unlistedBlockedNote(blockedCount - listedBlockedCount),
  };
}

/** Body for publish_proposal: only the blocked targets, which the agent must act on. */
export function agentWritePolicyPublishBody(result: HumanInvolvementPolicyResult) {
  const blocked = result.targets.filter((t) => !t.canWrite);
  return {
    can_write: result.canWrite,
    message: result.message,
    target_count: result.targets.length,
    blocked_target_count: blocked.length,
    targets: blocked.map(targetEntry),
  };
}
