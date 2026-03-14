import path from "node:path";
import { access, mkdir } from "node:fs/promises";

const DEFAULT_DATA_ROOT = "/app/data";

export function getDataRoot(): string {
  return path.resolve(process.env.KS_DATA_ROOT ?? DEFAULT_DATA_ROOT);
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

// ─── Snapshots ─────────────────────────────────────────────────────

export function getSnapshotRoot(): string {
  return path.resolve(process.env.KS_SNAPSHOT_ROOT ?? path.join(getDataRoot(), "snapshots"));
}

// ─── Import ────────────────────────────────────────────────────────

export function getImportRoot(): string {
  return path.resolve(process.env.KS_IMPORT_ROOT ?? "/import");
}

// ─── Ensure directories exist ──────────────────────────────────────

export async function ensureV3Directories(): Promise<void> {
  const dirs = [
    getContentRoot(),
    getProposalsPendingRoot(),
    getProposalsCommittingRoot(),
    getProposalsCommittedRoot(),
    getProposalsWithdrawnRoot(),
    getSessionDocsRoot(),
    getSessionFragmentsRoot(),
    getSessionAuthorsRoot(),
    getSnapshotRoot(),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}
