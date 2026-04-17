import type { DocumentTreeEntry } from "../types/shared.js";
import { parseRouteDocPath } from "./app-layout-utils";
import { getDocDisplayName } from "../pages/document-page-utils";

const PREFIX = "[Civigent] ";

function lookupEntryType(entries: DocumentTreeEntry[], docPath: string): "file" | "directory" | null {
  const stack = [...entries];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.path === docPath) {
      return node.type === "directory" ? "directory" : "file";
    }
    if (node.type === "directory" && Array.isArray(node.children) && node.children.length > 0) {
      stack.push(...node.children);
    }
  }
  return null;
}

/** Last path segment, for folder labels (matches FolderPage). */
function folderSegmentName(folderPath: string): string {
  if (folderPath === "/") {
    return "/";
  }
  const parts = folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

function titleForNonDocsRoute(pathname: string): string {
  if (pathname === "/" || pathname === "") {
    return `${PREFIX}What's New`;
  }
  if (pathname === "/recent-docs") {
    return `${PREFIX}Recent Documents`;
  }
  if (pathname === "/proposals") {
    return `${PREFIX}Proposals`;
  }
  if (pathname.startsWith("/proposals/")) {
    return `${PREFIX}Proposal Detail`;
  }
  if (pathname === "/admin") {
    return `${PREFIX}Administration`;
  }
  if (pathname === "/admin/agents-auth") {
    return `${PREFIX}Pre-Authenticated Agents`;
  }
  if (pathname === "/admin/permissions") {
    return `${PREFIX}Permissions`;
  }
  if (pathname === "/admin/snapshots") {
    return `${PREFIX}Snapshots`;
  }
  if (pathname === "/admin/agent-mcp-logs") {
    return `${PREFIX}Agent MCP Logs`;
  }
  if (pathname === "/session-inspector") {
    return `${PREFIX}Session Inspector`;
  }
  if (pathname === "/history") {
    return `${PREFIX}Git History`;
  }
  if (pathname === "/agent-simulator") {
    return `${PREFIX}Agent Simulator`;
  }
  if (pathname === "/coordination") {
    return `${PREFIX}Coordination`;
  }
  if (pathname === "/setup") {
    return `${PREFIX}Connect an Agent`;
  }
  if (pathname === "/features") {
    return `${PREFIX}Features`;
  }
  if (pathname === "/agents-activity") {
    return `${PREFIX}Agents`;
  }
  if (pathname === "/agents-activity/feed") {
    return `${PREFIX}Agent Activity Feed`;
  }
  if (pathname === "/imports") {
    return `${PREFIX}Imports`;
  }
  if (pathname === "/search-text") {
    return `${PREFIX}Text Search`;
  }
  if (pathname === "/login") {
    return `${PREFIX}Login`;
  }
  return `${PREFIX}Civigent`;
}

/**
 * Browser tab title: `[Civigent] …` for non-document UI; file documents use the
 * display name only (same stem as the in-page heading), matching filename.
 */
export function computeBrowserTabTitle(
  pathname: string,
  entries: DocumentTreeEntry[],
  treeLoading: boolean,
): string {
  if (pathname === "/docs" || pathname === "/docs/") {
    return `${PREFIX}Documents`;
  }

  const docPath = parseRouteDocPath(pathname);
  if (docPath) {
    const entryType = lookupEntryType(entries, docPath);
    if (entryType === "directory") {
      return `${PREFIX}Folder: ${folderSegmentName(docPath)}`;
    }
    if (entryType === "file") {
      return getDocDisplayName(docPath);
    }
    const looksLikeMarkdown = docPath.toLowerCase().endsWith(".md");
    if (looksLikeMarkdown) {
      return getDocDisplayName(docPath);
    }
    if (treeLoading) {
      return `${PREFIX}Documents`;
    }
    return `${PREFIX}Folder: ${folderSegmentName(docPath)}`;
  }

  return titleForNonDocsRoute(pathname);
}
