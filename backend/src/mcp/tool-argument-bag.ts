/**
 * Closed tool-argument bag — refuse names the tool did not declare.
 *
 * A key is legal iff it is in the tool's advertised `properties`. Handlers
 * only bind the names they know, so an undeclared sibling (`doc_path` on a
 * tool that declared `root`) used to succeed with the optional default.
 * `ToolRegistry.callTool` runs this before the handler so every tool is closed.
 *
 * Required fields and value types stay in the handlers. This module does not
 * invent an opt-out: a name the tool should accept belongs in `properties`.
 */

import type { McpToolCallResult, McpToolDefinition } from "./protocol.js";
import { makeToolErrorResult } from "./protocol.js";

export function refuseUnknownToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  schema: McpToolDefinition["inputSchema"],
): McpToolCallResult | null {
  const declared = Object.keys(schema.properties);
  const declaredSet = new Set(declared);
  const unknown = Object.keys(args).filter((key) => !declaredSet.has(key));
  if (unknown.length === 0) return null;

  const accepted = declared.length > 0 ? declared.join(", ") : "no arguments";
  const noun = unknown.length === 1 ? "argument" : "arguments";
  return makeToolErrorResult(
    `Unknown ${noun}: ${unknown.join(", ")}. ${toolName} accepts: ${accepted}.`,
  );
}
