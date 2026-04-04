import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { readEnvVar } from "../env.js";

const DEFAULT_DATA_ROOT = "/app/data";

export function getDataRoot(): string {
  return path.resolve(readEnvVar("KS_DATA_ROOT", DEFAULT_DATA_ROOT));
}

export async function assertDataRootExists(): Promise<void> {
  const root = getDataRoot();
  await access(root);
}

export function getContentRoot(): string {
  return path.join(getDataRoot(), "content");
}

// ─── Proposals (v3: 4-state lifecycle) ─────────────────────────────

export function getProposalsRoot(): string {
  return path.join(getDataRoot(), "proposals");
}

export function getProposalsDraftRoot(): string {
  return path.join(getDataRoot(), "proposals", "draft");
}

export function getProposalsPendingRoot(): string {
  return path.join(getDataRoot(), "proposals", "pending");
}

export function getProposalsCommittingRoot(): string {
  return path.join(getDataRoot(), "proposals", "committing");
}

export function getProposalsCommittedRoot(): string {
  return path.join(getDataRoot(), "proposals", "committed");
}

export function getProposalsWithdrawnRoot(): string {
  return path.join(getDataRoot(), "proposals", "withdrawn");
}

// ─── Sessions (v3: human CRDT editing sessions on disk) ────────────

export function getSessionsRoot(): string {
  return path.join(getDataRoot(), "sessions");
}

/** Crash-safety layer: dirty section content + skeletons (mirrors content/ structure) */
export function getSessionDocsRoot(): string {
  return path.join(getDataRoot(), "sessions", "docs");
}

/** Raw fragment files: verbatim markdown from Y.XmlFragment (heading + body) */
export function getSessionFragmentsRoot(): string {
  return path.join(getDataRoot(), "sessions", "fragments");
}

/** Per-user attribution/Mirror layer: which sections each user has dirtied */
export function getSessionAuthorsRoot(): string {
  return path.join(getDataRoot(), "sessions", "authors");
}

/** The content subdirectory of the session docs overlay root. */
export function getSessionDocsContentRoot(): string {
  return path.join(getSessionDocsRoot(), "content");
}

/** Root directory for import staging areas (one subdir per import ID). */
export function getImportStagingRoot(): string {
  return path.join(getDataRoot(), "import-staging");
}

// ─── Git-relative path prefixes ─────────────────────────────────────

/**
 * Git-relative prefix for the content directory.
 * Use this when constructing paths for git command arguments (e.g. git add, git checkout).
 * Returns "content" (no trailing slash). Callers append "/" or "/${docPath}" as needed.
 */
export function getContentGitPrefix(): string {
  return path.relative(getDataRoot(), getContentRoot());
}

/**
 * Git-relative prefix for the proposals directory.
 * Returns "proposals" (no trailing slash).
 */
export function getProposalsGitPrefix(): string {
  return path.relative(getDataRoot(), getProposalsRoot());
}

// ─── Auth ─────────────────────────────────────────────────────────

export function getAuthRoot(): string {
  return path.join(getDataRoot(), "auth");
}

// ─── Snapshots ─────────────────────────────────────────────────────

export function getSnapshotRoot(): string {
  return path.resolve(readEnvVar("KS_SNAPSHOT_ROOT", path.join(getDataRoot(), "snapshots")));
}

// ─── Import ────────────────────────────────────────────────────────

export function getImportRoot(): string {
  return path.resolve(readEnvVar("KS_IMPORT_ROOT", "/import"));
}

// ─── Monitoring ─────────────────────────────────────────────────────

export function getMonitoringRoot(): string {
  return path.join(getDataRoot(), "monitoring");
}

// ─── Ensure directories exist ──────────────────────────────────────

export async function ensureV3Directories(): Promise<void> {
  const dirs = [
    getContentRoot(),
    getProposalsDraftRoot(),
    getProposalsPendingRoot(),
    getProposalsCommittingRoot(),
    getProposalsCommittedRoot(),
    getProposalsWithdrawnRoot(),
    getSessionDocsRoot(),
    getSessionFragmentsRoot(),
    getSessionAuthorsRoot(),
    getAuthRoot(),
    getSnapshotRoot(),
    getMonitoringRoot(),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}
