/**
 * bootstrap-content-seed.ts — Startup-only content seeding.
 *
 * Seeds an EMPTY canonical store from a source directory of markdown files as
 * a proposal-mediated immediate canonical commit. Runs only before normal
 * readiness, with no active users and no active sessions; this is NOT the
 * general runtime/admin import path (those go through the normal import flow).
 *
 * It is a thin orchestrator over `importFilesToProposal` + an immediate
 * `publishProposalToCanonical`; the `ProposalEditor` routing is inherited
 * transitively through `importFilesToProposal`.
 */

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { directoryExists, readDirentsIfExists, readFileIfExists } from "./fs-primitives.js";
import { docPathFromContentRelativeFsPath } from "./path-utils.js";
import { getContentRoot } from "./data-root.js";
import { importFilesToProposal, type ImportFile } from "./import-service.js";
import { publishProposalToCanonical } from "./commit-pipeline.js";
import { systemAuthority } from "../auth/system-authority.js";
import type { WriterIdentity } from "../types/shared.js";

export interface BootstrapContentSeedSummary {
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
  const content = await readFileIfExists(ignorePath);
  if (content === null) return [];
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
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

export async function bootstrapContentSeed(sourceRoot: string): Promise<BootstrapContentSeedSummary> {
  const contentRoot = getContentRoot();
  const summary: BootstrapContentSeedSummary = { imported: 0, failed: 0, skipped: 0, errors: [] };

  // An absent contentRoot is a valid "fresh install" state (it will be created
  // by the proposal pipeline) and counts as empty, so seeding proceeds. A
  // non-empty contentRoot means content already exists, so we skip.
  const existingEntries = await readDirentsIfExists(contentRoot);
  if (existingEntries.length > 0) {
    summary.skipped += 1;
    return summary;
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
      importFiles.push({ docPath: docPathFromContentRelativeFsPath(normalizeRelPath(relPath)), content });
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
  // Startup-only seed: zero scores (empty SectionScoreSnapshot) and an explicit
  // bootstrap-seed commit message rather than the default `agent proposal:`
  // line. See assumptions.md (bootstrap commit-metadata decision).
  await publishProposalToCanonical(proposalId, {}, undefined, {
    authority: systemAuthority("bootstrap content seed"),
    commitMessageOverride: `bootstrap seed: initial content import from ${sourceRoot}\n\nProposal: ${proposalId}`,
  });
  summary.imported += importFiles.length;

  return summary;
}

export async function bootstrapContentSeedFromDirectoryIfNeeded(
  sourceRoot: string,
): Promise<BootstrapContentSeedSummary> {
  // Optional: compose mounts /dev/null at /import when IMPORT_CONTENT_FROM is
  // unset, so the path can exist without being a directory (ENOTDIR on scandir).
  if (!(await directoryExists(sourceRoot))) {
    return { imported: 0, failed: 0, skipped: 1, errors: [] };
  }
  return bootstrapContentSeed(sourceRoot);
}
