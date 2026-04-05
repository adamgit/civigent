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
];

export function toolColor(toolName: string): string {
  const index = ALL_MCP_TOOLS.indexOf(toolName);
  if (index === -1) {
    return "hsl(0, 0%, 70%)";
  }
  const hue = (index / Math.max(ALL_MCP_TOOLS.length, 1)) * 360;
  return `hsl(${hue.toFixed(1)}, 65%, 55%)`;
}
