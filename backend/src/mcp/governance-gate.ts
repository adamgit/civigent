/**
 * Governance gate for the filesystem-facing MCP tiers.
 *
 * When the deployment's governance mode is "forced", every Tier 1 and Tier 2 tool
 * call (reads and writes alike) is rejected before its handler runs; the agent must
 * instead use the Tier 3 explicit proposal-management workflow. Tier 3 is never
 * gated — it IS the sanctioned governance surface.
 *
 * The mode is read at call time (via `getAdminConfig()`, which resolves
 * `KS_GOVERNANCE_MODE` on every read) so toggling governance affects new calls
 * without a server restart.
 */

import { getAdminConfig } from "../admin-config.js";

/** MCP service tier: 1 = filesystem read/write, 2 = +plan_changes, 3 = proposal workflow. */
export type GatedTier = 1 | 2 | 3;

/**
 * Decide whether a tool call on the given tier must be rejected because the
 * deployment is in `forced` governance mode.
 *
 * Returns the full explanatory prose to surface to the agent when the call must be
 * rejected, or `null` when the call may proceed. Per the error policy this carries
 * NO error code — only the action-oriented message pointing at the Tier 3 workflow.
 */
export function governanceForcedRejection(tier: GatedTier): string | null {
  if (tier === 3) return null;
  if (getAdminConfig().governance_mode !== "forced") return null;
  return (
    'This deployment\'s governance mode is set to "forced": the Tier 1 and Tier 2 ' +
    "filesystem MCP tools (reads and writes alike) are disabled. You must use the " +
    "Tier 3 explicit proposal-management workflow at /mcp/tier3 — stage changes with " +
    "create_proposal and submit them for governance with publish_proposal."
  );
}
