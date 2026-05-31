import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { WriterIdentity } from "../../types/shared.js";
import {
  createStagingFolder,
  listStagingFolders,
  scanStagingFolder,
  readStagingFiles,
  deleteStagingFolder,
  getImportStagingRoot,
} from "../../storage/import-staging.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { humanBypassPolicyResult } from "../../domain/agent-write-policy.js";

export { humanBypassPolicyResult };

export type ImportWriter = Pick<WriterIdentity, "id" | "type" | "displayName" | "email">;

export interface UploadFile {
  name: string;
  content: string;
}

export async function createImport(): Promise<{ importId: string; stagingPath: string }> {
  return createStagingFolder();
}

export async function listImports() {
  const folders = await listStagingFolders();
  return folders.map((f) => ({
    import_id: f.importId,
    staging_path: f.stagingPath,
    created_at: f.createdAt,
  }));
}

export function importStagingPath(importId: string): string {
  return path.join(getImportStagingRoot(), importId);
}

export async function stagingFolderExists(importId: string): Promise<boolean> {
  try {
    await stat(importStagingPath(importId));
    return true;
  } catch {
    return false;
  }
}

export class ImportUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportUploadError";
  }
}

/**
 * Write uploaded multipart files into the staging folder, validating each path.
 * Throws ImportUploadError (400-class) on validation failure. Returns count.
 */
export async function writeUploadedFiles(importId: string, files: UploadFile[]): Promise<number> {
  const stagingPath = importStagingPath(importId);
  let uploaded = 0;
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".md")) {
      throw new ImportUploadError(`Only .md files are accepted. Got: ${f.name}`);
    }
    const relativePath = f.name.replace(/\\/g, "/").replace(/^\/+/, "");
    const pathSegments = relativePath.split("/");
    if (
      relativePath.length === 0 ||
      pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new ImportUploadError(`Invalid file path: ${f.name}`);
    }
    const filePath = path.resolve(stagingPath, ...pathSegments);
    // Prevent path traversal
    if (filePath !== stagingPath && !filePath.startsWith(stagingPath + path.sep)) {
      throw new ImportUploadError(`Invalid file path: ${f.name}`);
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, f.content, "utf8");
    uploaded++;
  }
  return uploaded;
}

export async function scanImport(importId: string) {
  const files = await scanStagingFolder(importId);
  return {
    import_id: importId,
    staging_path: importStagingPath(importId),
    files: files.map((f) => ({
      path: f.relativePath,
      is_markdown: f.isMarkdown,
      section_count: f.sectionCount,
      is_internal_artifact: f.isInternalArtifact,
      rejection_reason: f.rejectionReason,
    })),
  };
}

export class ImportEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportEmptyError";
  }
}

export interface CommitImportResult {
  proposalId: string;
  committedHead: string;
  sections: Array<{ doc_path: string; heading_path: string[] }>;
  diagnostics: string[];
}

/**
 * Run the staged files through the shared import pipeline → ProposalEditor →
 * canonical commit. Human imports commit directly (humans bypass Agent Write
 * Policy, spec 12). Deletes the staging folder on success.
 */
export async function commitImport(importId: string, writer: ImportWriter, description: string): Promise<CommitImportResult> {
  const stagingFiles = await readStagingFiles(importId);
  if (stagingFiles.length === 0) {
    throw new ImportEmptyError("Staging folder is empty or contains no .md files.");
  }

  const { id: importProposalId } = await importFilesToProposal(
    stagingFiles,
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description.trim(),
  );

  const freshProposal = await readProposal(importProposalId);

  const importDiagnostics: string[] = [];
  const committedHead = await commitProposalToCanonical(importProposalId, {}, importDiagnostics);
  await deleteStagingFolder(importId);

  return {
    proposalId: importProposalId,
    committedHead,
    sections: freshProposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
    diagnostics: importDiagnostics,
  };
}

export async function removeImport(importId: string): Promise<void> {
  await deleteStagingFolder(importId);
}
