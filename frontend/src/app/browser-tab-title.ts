import { getDocDisplayName } from "../pages/document-page-utils";
import { FolderPath } from "../types/shared";
import { DocsLocation } from "./docs-location";

export interface BrowserTabFileEditFlags {
  hasInFlightEdits: boolean;
  hasUnpublishedChanges: boolean;
}

/** `label << appName` — app name omitted when empty. */
function withAppName(label: string, appName: string): string {
  const trimmedApp = appName.trim();
  if (!trimmedApp) {
    return label;
  }
  return `${label} << ${trimmedApp}`;
}

function folderTabLabel(folderPath: FolderPath): string {
  if (folderPath === FolderPath.root) {
    return "./";
  }
  return `./${FolderPath.displayName(folderPath)}/`;
}

/** `!` (in-flight) before optional `*` (unpublished shared draft), then the filename. */
function fileTabLabel(name: string, flags: BrowserTabFileEditFlags): string {
  const prefixes: string[] = [];
  if (flags.hasInFlightEdits) {
    prefixes.push("!");
  }
  if (flags.hasUnpublishedChanges) {
    prefixes.push("*");
  }
  return prefixes.length > 0 ? `${prefixes.join(" ")} ${name}` : name;
}

function titleForSpecialRoute(pathname: string): string {
  if (pathname === "/" || pathname === "") {
    return "What's New";
  }
  if (pathname === "/recent-docs") {
    return "Recent Documents";
  }
  if (pathname === "/proposals") {
    return "Proposals";
  }
  if (pathname.startsWith("/proposals/")) {
    return "Proposal Detail";
  }
  if (pathname === "/admin") {
    return "Administration";
  }
  if (pathname === "/admin/agents-auth") {
    return "Pre-Authenticated Agents";
  }
  if (pathname === "/admin/permissions") {
    return "Permissions";
  }
  if (pathname === "/admin/snapshots") {
    return "Snapshots";
  }
  if (pathname === "/admin/agent-mcp-logs") {
    return "Agent MCP Logs";
  }
  if (pathname === "/admin/runtime-memory") {
    return "Runtime Memory";
  }
  if (pathname === "/admin/content-integrity") {
    return "Content Integrity";
  }
  if (pathname === "/admin/git-backup") {
    return "Git Backup";
  }
  if (pathname === "/history") {
    return "Git History";
  }
  if (pathname === "/agent-simulator") {
    return "Agent Simulator";
  }
  if (pathname === "/coordination") {
    return "Coordination";
  }
  if (pathname === "/setup") {
    return "Connect an Agent";
  }
  if (pathname === "/features") {
    return "Features";
  }
  if (pathname === "/agents-activity") {
    return "Agents";
  }
  if (pathname === "/agents-activity/feed") {
    return "Agent Activity Feed";
  }
  if (pathname === "/skills") {
    return "Skills";
  }
  if (pathname === "/imports") {
    return "Imports";
  }
  if (pathname === "/search-text") {
    return "Text Search";
  }
  if (pathname === "/login") {
    return "Login";
  }
  return "Civigent";
}

/**
 * Browser tab title schemes:
 * - file: `filename << {appName}`
 * - in-flight file: `! filename << {appName}`
 * - unpublished file: `* filename << {appName}`
 * - both: `! * filename << {appName}`
 * - folder: `./foldername/ << {appName}` (leaf segment only; root is `./`)
 * - special: `(label) << {appName}`
 */
export function computeBrowserTabTitle(
  pathname: string,
  appName: string,
  fileEditFlags: BrowserTabFileEditFlags = {
    hasInFlightEdits: false,
    hasUnpublishedChanges: false,
  },
): string {
  const loc = DocsLocation.fromPathname(pathname);
  if (loc?.kind === "doc") {
    return withAppName(fileTabLabel(getDocDisplayName(loc.docPath), fileEditFlags), appName);
  }
  if (loc?.kind === "folder") {
    return withAppName(folderTabLabel(loc.folderPath), appName);
  }
  return withAppName(`(${titleForSpecialRoute(pathname)})`, appName);
}
