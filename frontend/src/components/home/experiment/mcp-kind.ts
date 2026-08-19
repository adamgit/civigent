const READ_TOOLS = new Set([
  "read_doc",
  "read_file",
  "read_published_section",
  "read_doc_structure",
  "read_proposal",
  "read_proposal_section",
  "list_documents",
  "list_directory",
  "list_sections",
  "search_text",
]);

const WRITE_TOOLS = new Set([
  "write_file",
  "write_files",
  "write_proposal_section",
  "create_section",
  "delete_section",
  "move_section",
  "reorder_section",
  "delete_file",
  "move_file",
  "delete_document",
  "rename_section",
  "rename_document",
  "apply_patch",
  "publish_proposal",
  "commit_proposal",
]);

export function isReadTool(method: string): boolean {
  return READ_TOOLS.has(method);
}

export function isWriteTool(method: string): boolean {
  return WRITE_TOOLS.has(method);
}
