import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { importFilesToProposal, type ImportFile } from "./import-service.js";
import { commitProposalToCanonical } from "./commit-pipeline.js";
import type { WriterIdentity } from "../types/shared.js";

export interface ContentImportSummary {
  imported: number;
  failed: number;
  skipped: number;
  errors: string[];
}

const SYSTEM_WRITER: WriterIdentity = {
  id: "system",
  type: "human",
  displayName: "System",
  email: "system@civigent",
};

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readImportIgnorePatterns(sourceRoot: string): Promise<string[]> {
  const ignorePath = path.join(sourceRoot, ".importignore");
  try {
    const content = await readFile(ignorePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function isIgnored(relPath: string, isDirectory: boolean, patterns: string[]): boolean {
  const normalized = normalizeRelPath(relPath);
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      const prefix = pattern.slice(0, -1).replace(/^\/+/, "");
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true;
      }
      continue;
    }
    if (pattern.startsWith("*.")) {
      if (!isDirectory && normalized.endsWith(pattern.slice(1))) {
        return true;
      }
      continue;
    }
    const normalizedPattern = pattern.replace(/^\/+/, "");
    if (normalized === normalizedPattern) {
      return true;
    }
  }
  return false;
}

async function collectImportMarkdownFiles(sourceRoot: string, patterns: string[]): Promise<string[]> {
  const files: string[] = [];

  const visit = async (relativeDir: string) => {
    const absoluteDir = path.join(sourceRoot, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = normalizeRelPath(path.join(relativeDir, entry.name));
      if (isIgnored(relPath, entry.isDirectory(), patterns)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(relPath);
        continue;
      }
      if (entry.isFile() && relPath.toLowerCase().endsWith(".md")) {
        files.push(relPath);
      }
    }
  };

  await visit("");
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

async function isDirectoryEmpty(targetDir: string): Promise<boolean> {
  const entries = await readdir(targetDir, { withFileTypes: true });
  return entries.length === 0;
}

export async function importContent(sourceRoot: string, contentRoot: string): Promise<ContentImportSummary> {
  const summary: ContentImportSummary = { imported: 0, failed: 0, skipped: 0, errors: [] };

  try {
    if (!(await isDirectoryEmpty(contentRoot))) {
      summary.skipped += 1;
      return summary;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // contentRoot doesn't exist yet — will be created by the proposal pipeline
  }

  const ignorePatterns = await readImportIgnorePatterns(sourceRoot);
  const markdownFiles = await collectImportMarkdownFiles(sourceRoot, ignorePatterns);
  if (markdownFiles.length === 0) {
    return summary;
  }

  const importFiles: ImportFile[] = [];
  for (const relPath of markdownFiles) {
    try {
      const sourcePath = path.join(sourceRoot, relPath);
      const content = await readFile(sourcePath, "utf8");
      importFiles.push({ docPath: relPath, content });
    } catch (error) {
      summary.failed += 1;
      summary.errors.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (importFiles.length === 0) {
    return summary;
  }

  const { id: proposalId } = await importFilesToProposal(
    importFiles,
    SYSTEM_WRITER,
    `Bootstrap import from ${sourceRoot}`,
  );
  await commitProposalToCanonical(proposalId, {});
  summary.imported += importFiles.length;

  return summary;
}

export async function importContentFromDirectoryIfNeeded(
  sourceRoot: string,
  contentRoot: string,
): Promise<ContentImportSummary> {
  try {
    await readdir(sourceRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { imported: 0, failed: 0, skipped: 1, errors: [] };
    }
    throw error;
  }
  return importContent(sourceRoot, contentRoot);
}
