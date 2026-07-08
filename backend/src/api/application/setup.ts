/**
 * Setup application service — neutral home for the tool-key catalog.
 *
 * `getToolKeyCatalog` lives here (not in the MCP router assembly) so that both the
 * `/api/setup` route and any MCP-side setup path can import it without a route module
 * reaching into `../../mcp/` directly (see route-import-discipline test).
 */

import { ToolRegistry } from "../../mcp/tool-registry.js";
import { registerFilesystemTools, registerPlanChangesTool } from "../../mcp/tools/filesystem.js";
import { registerCollaborationTools } from "../../mcp/tools/collaboration.js";
import { registerStructuralTools } from "../../mcp/tools/structural.js";

/**
 * Build the stable-`key` → current-wire-`name` catalog for EVERY tool across all
 * tiers. The frontend uses this to substitute `{{tool:key}}` tokens in the served
 * `skill.md` / `cursor-rule.md` templates, so it must cover any tool those docs
 * reference regardless of tier (no name/key collisions exist across tiers).
 */
export function getToolKeyCatalog(): Record<string, string> {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  registerPlanChangesTool(registry);
  registerCollaborationTools(registry);
  registerStructuralTools(registry);
  return registry.toolKeyCatalog();
}
