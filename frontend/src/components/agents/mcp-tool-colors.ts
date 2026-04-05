export const ALL_MCP_TOOLS: string[] = [
  "cancel_proposal",
  "commit_proposal",
  "create_proposal",
  "create_section",
  "delete_document",
  "delete_file",
  "delete_section",
  "list_directory",
  "list_documents",
  "list_sections",
  "list_proposals",
  "move_file",
  "move_section",
  "my_proposals",
  "plan_changes",
  "read_doc",
  "read_doc_structure",
  "read_file",
  "read_proposal",
  "read_section",
  "rename_section",
  "search_text",
  "write_file",
  "write_files",
  "write_section",
  "delete_document",
];

// Deduplicate while preserving order.
// Note: delete_document appears twice in the spec — we keep it once at its position
const UNIQUE_MCP_TOOLS: string[] = Array.from(new Set(ALL_MCP_TOOLS));

export function toolColor(toolName: string): string {
  const index = UNIQUE_MCP_TOOLS.indexOf(toolName);
  if (index === -1) {
    return "hsl(0, 0%, 70%)";
  }
  const hue = (index / Math.max(UNIQUE_MCP_TOOLS.length, 1)) * 360;
  return `hsl(${hue.toFixed(1)}, 65%, 55%)`;
}
