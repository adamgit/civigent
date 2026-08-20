import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import type { FolderPath, WriterIdentity } from "../../types/shared.js";
import { DocPath, proposalSectionsParsedForLiveUse } from "../../types/shared.js";
import {
  createStagingFolder,
  listStagingFolders,
  scanStagingFolder,
  readStagingFiles,
  readStagingFile,
  writeStagingFile,
  readImportStagingMeta,
  deleteStagingFolder,
  getImportStagingRoot,
  stagingFilesRoot,
  stagingZipSpoolPath,
  ImportStagingPathError,
} from "../../storage/import-staging.js";
import { importFilesToProposal, type ImportFile } from "../../storage/import-service.js";
import { applyImportResolution, ImportResolutionError } from "../../storage/import-resolutions.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { propagateCommitToLiveSessions } from "../../ws/crdt-ws-coordinator.js";
import { humanBypassPolicyResult } from "../../domain/agent-write-policy.js";

export { ImportValidationError } from "../../storage/import-service.js";
export { ImportResolutionError } from "../../storage/import-resolutions.js";
export { humanBypassPolicyResult };

export type ImportWriter = Pick<WriterIdentity, "id" | "type" | "displayName" | "email">;

export interface UploadFile {
  name: string;
  content: string;
}

export async function createImport(targetFolder: FolderPath): Promise<{ importId: string; stagingPath: string }> {
  return createStagingFolder(targetFolder);
}

export async function listImports() {
  const folders = await listStagingFolders();
  return folders.map((f) => ({
    import_id: f.importId,
    staging_path: f.stagingPath,
    created_at: f.createdAt,
    target_folder: f.targetFolder,
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
  const filesRoot = stagingFilesRoot(importId);
  let uploaded = 0;
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(".md")) {
      throw new ImportUploadError(`Only .md files are accepted. Got: ${f.name}`);
    }
    const relativePath = DocPath.normalizeMarkdownFileName(f.name.replace(/\\/g, "/").replace(/^\/+/, ""));
    const pathSegments = relativePath.split("/");
    if (
      relativePath.length === 0 ||
      pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new ImportUploadError(`Invalid file path: ${f.name}`);
    }
    const filePath = path.resolve(filesRoot, ...pathSegments);
    // Prevent path traversal
    if (filePath !== filesRoot && !filePath.startsWith(filesRoot + path.sep)) {
      throw new ImportUploadError(`Invalid file path: ${f.name}`);
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, f.content, "utf8");
    uploaded++;
  }
  return uploaded;
}

export const MAX_ZIP_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRY_COUNT = 10_000;
export const MAX_ZIP_EXTRACTED_BYTES = 1024 * 1024 * 1024;

export class ImportZipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportZipTooLargeError";
  }
}

export async function spoolImportZipUpload(importId: string, body: AsyncIterable<Buffer | string>): Promise<void> {
  const spoolPath = stagingZipSpoolPath(importId);
  await rm(spoolPath, { force: true });
  const handle = await open(spoolPath, "w");
  let bytes = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_ZIP_UPLOAD_BYTES) {
        throw new ImportZipTooLargeError(`Zip upload exceeds the ${MAX_ZIP_UPLOAD_BYTES}-byte limit.`);
      }
      await handle.write(buffer);
    }
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(spoolPath, { force: true });
    throw error;
  }
}

function zipEntryPathSegments(entryFileName: string, filesRoot: string): string[] {
  const normalized = entryFileName.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ImportUploadError(`Invalid zip entry path: ${entryFileName}`);
  }
  const resolved = path.resolve(filesRoot, ...segments);
  if (resolved === filesRoot || !resolved.startsWith(filesRoot + path.sep)) {
    throw new ImportUploadError(`Invalid zip entry path: ${entryFileName}`);
  }
  const leaf = segments[segments.length - 1];
  if (/\.md$/i.test(leaf)) {
    segments[segments.length - 1] = DocPath.normalizeMarkdownFileName(leaf);
  }
  return segments;
}

function isSymlinkZipEntry(entry: yauzl.Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000;
}

async function writeZipEntryCountingBytes(
  source: Readable,
  destPath: string,
  bytesAlreadyWritten: number,
): Promise<number> {
  let total = bytesAlreadyWritten;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_ZIP_EXTRACTED_BYTES) {
        callback(new ImportUploadError(`Zip expands past the ${MAX_ZIP_EXTRACTED_BYTES}-byte extraction limit.`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(source, cap, createWriteStream(destPath));
  return total;
}

export async function extractImportZipSpool(importId: string): Promise<number> {
  const spoolPath = stagingZipSpoolPath(importId);
  const filesRoot = stagingFilesRoot(importId);
  try {
    let zipfile: yauzl.ZipFile;
    try {
      zipfile = await yauzl.openPromise(spoolPath, { autoClose: false });
    } catch (error) {
      throw new ImportUploadError(
        `Could not read zip archive: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (zipfile.entryCount > MAX_ZIP_ENTRY_COUNT) {
        throw new ImportUploadError(
          `Zip contains ${zipfile.entryCount} entries; the maximum is ${MAX_ZIP_ENTRY_COUNT}.`,
        );
      }
      const fileEntries: Array<{ entry: yauzl.Entry; segments: string[] }> = [];
      try {
        for await (const entry of zipfile.eachEntry()) {
          if (entry.fileName.endsWith("/")) continue;
          if (isSymlinkZipEntry(entry)) continue;
          fileEntries.push({ entry, segments: zipEntryPathSegments(entry.fileName, filesRoot) });
        }
      } catch (error) {
        if (error instanceof ImportUploadError) throw error;
        throw new ImportUploadError(
          `Could not read zip archive: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let writtenBytes = 0;
      for (const { entry, segments } of fileEntries) {
        const destPath = path.resolve(filesRoot, ...segments);
        await mkdir(path.dirname(destPath), { recursive: true });
        const readStream = await zipfile.openReadStreamPromise(entry);
        try {
          writtenBytes = await writeZipEntryCountingBytes(readStream, destPath, writtenBytes);
        } catch (error) {
          await rm(destPath, { force: true });
          throw error;
        }
      }
      return fileEntries.length;
    } finally {
      zipfile.close();
    }
  } finally {
    await rm(spoolPath, { force: true });
  }
}

export async function scanImport(importId: string) {
  const meta = await readImportStagingMeta(importId);
  const files = await scanStagingFolder(importId);
  return {
    import_id: importId,
    staging_path: importStagingPath(importId),
    target_folder: meta.targetFolder,
    files: files.map((f) => ({
      path: f.relativePath,
      is_markdown: f.isMarkdown,
      section_count: f.sectionCount,
      is_internal_artifact: f.isInternalArtifact,
      rejection_reason: f.rejectionReason,
      applicable_resolutions: f.applicableResolutions,
    })),
  };
}

export class ImportEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportEmptyError";
  }
}

export type ImportCommitProgressEvent =
  | { kind: "document_written"; index: number; total: number; docPath: DocPath }
  | { kind: "publishing" };

export interface CommitImportResult {
  proposalId: string;
  committedHead: string;
  sections: Array<{ doc_path: string; heading_path: string[] }>;
  diagnostics: string[];
}

export async function resolveImportFile(
  importId: string,
  relativePath: string,
  resolutionId: string,
  params?: unknown,
): Promise<Awaited<ReturnType<typeof scanImport>>> {
  const scanned = await scanStagingFolder(importId);
  const file = scanned.find((entry) => entry.relativePath === relativePath);
  if (!file) {
    throw new ImportResolutionError(`File not in this import: ${relativePath}`);
  }
  if (!file.isMarkdown || file.isInternalArtifact) {
    throw new ImportResolutionError("This file cannot be repaired.");
  }
  if (!file.applicableResolutions.some((resolution) => resolution.id === resolutionId)) {
    throw new ImportResolutionError("That repair does not apply to this file.");
  }
  let content: string;
  try {
    content = await readStagingFile(importId, relativePath);
  } catch (error) {
    if (error instanceof ImportStagingPathError) {
      throw new ImportResolutionError(error.message);
    }
    throw error;
  }
  const next = applyImportResolution(content, resolutionId, params);
  try {
    await writeStagingFile(importId, relativePath, next);
  } catch (error) {
    if (error instanceof ImportStagingPathError) {
      throw new ImportResolutionError(error.message);
    }
    throw error;
  }
  return scanImport(importId);
}

/**
 * Run the staged files through the shared import pipeline → ProposalEditor →
 * canonical commit. Human imports commit directly (humans bypass Agent Write
 * Policy, spec 12). Deletes the staging folder on success. Files the scan
 * rejected (corrupt markdown, internal artifacts, non-markdown) are skipped
 * rather than failing the whole import.
 */
export async function commitImport(
  importId: string,
  writer: ImportWriter,
  description: string,
  onProgress?: (event: ImportCommitProgressEvent) => void,
): Promise<CommitImportResult> {
  const meta = await readImportStagingMeta(importId);
  const scanned = await scanStagingFolder(importId);
  const rejectedPaths = new Set(
    scanned.filter((file) => file.rejectionReason !== null).map((file) => file.relativePath),
  );
  const stagedFiles = (await readStagingFiles(importId)).filter((file) => !rejectedPaths.has(file.relativePath));
  if (stagedFiles.length === 0) {
    const excludedCount = rejectedPaths.size;
    throw new ImportEmptyError(
      excludedCount > 0
        ? `No importable markdown files (${excludedCount} excluded). Repair excluded files or add valid .md files.`
        : "Staging folder is empty or contains no .md files.",
    );
  }
  const importFiles: ImportFile[] = stagedFiles.map((f) => ({
    docPath: DocPath.fileInFolder(meta.targetFolder, f.relativePath),
    content: f.content,
  }));

  const { id: importProposalId } = await importFilesToProposal(
    importFiles,
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description.trim(),
    (progress) => onProgress?.({ kind: "document_written", ...progress }),
  );

  const freshProposal = await readProposal(importProposalId);

  const importDiagnostics: string[] = [];
  onProgress?.({ kind: "publishing" });
  const absorbResult = await publishProposalToCanonicalDetailed(importProposalId, {}, importDiagnostics);
  const committedHead = absorbResult.commitSha;
  await propagateCommitToLiveSessions(absorbResult, importProposalId);
  await deleteStagingFolder(importId);

  return {
    proposalId: importProposalId,
    committedHead,
    sections: proposalSectionsParsedForLiveUse(freshProposal).map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
    diagnostics: importDiagnostics,
  };
}

export async function removeImport(importId: string): Promise<void> {
  await deleteStagingFolder(importId);
}
