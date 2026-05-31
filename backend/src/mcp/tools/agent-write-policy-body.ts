/**
 * Shared shaper turning an agent-write-policy result into an MCP response body.
 *
 * Surfaces the policy's prose `message`s (top-level + per-target) instead of
 * bare reason codes / enums. Area M owns the final verbose, action-oriented
 * wording; this is the interim shared shape every MCP agent surface renders.
 */

import type { HumanInvolvementPolicyResult } from "../../types/shared.js";

export function agentWritePolicyToolBody(result: HumanInvolvementPolicyResult) {
  return {
    can_write: result.canWrite,
    message: result.message,
    targets: result.targets.map((t) => ({
      doc_path: t.target.doc_path,
      heading_path: t.target.heading_path,
      can_write: t.canWrite,
      message: t.message,
    })),
  };
}
