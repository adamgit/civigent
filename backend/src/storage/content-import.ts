import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { DocumentSkeleton } from "./document-skeleton.js";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export interface ParsedImportSection {
  heading: string;
  depth: number;
  body: string;
}

export interface ContentImportSummary {
  imported: number;
  failed: number;
  skipped: number;
  errors: string[];
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function parseImportDocument(_docPath: string, markdown: string): { sections: ParsedImportSection[] } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const sections: Array<{ heading: string; depth: number; bodyLines: string[]; level: number; parentPath: string[] }> = [];
  const stack: Array<{ heading: string; level: number; path: string[] }> = [];
  let current: { heading: string; depth: number; bodyLines: string[]; level: number; parentPath: string[] } | null = null;
  const seenByParent = new Map<string, Set<string>>();

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line.trim());
    if (headingMatch) {
      const rawLevel = headingMatch[1].length;
      const heading = headingMatch[2].trim();

      const level = rawLevel;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const parentPath = stack.length > 0 ? stack[stack.length - 1].path : [];
      const parentKey = parentPath.map((part) => part.toLowerCase()).join("\u001f");
      const seenSet = seenByParent.get(parentKey) ?? new Set<string>();
      const normalizedHeading = heading.toLowerCase();
      if (seenSet.has(normalizedHeading)) {
        throw new Error(`Duplicate heading "${heading}" under parent "${parentPath.join(" > ")}".`);
      }
      seenSet.add(normalizedHeading);
      seenByParent.set(parentKey, seenSet);

      const node = {
        heading,
        depth: level,
        bodyLines: [] as string[],
        level,
        parentPath,
      };
      sections.push(node);
      const nodePath = [...parentPath, heading];
      stack.push({ heading, level, path: nodePath });
      current = node;
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    }
  }

  return {
    sections: sections.map((section) => ({
      heading: section.heading,
      depth: section.depth,
      body: section.bodyLines.join("\n").replace(/\s+$/g, ""),
    })),
  };
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

async function importOneFile(
  sourceRoot: string,
  contentRoot: string,
  relPath: string,
): Promise<void> {
  const sourcePath = path.join(sourceRoot, relPath);
  const markdown = await readFile(sourcePath, "utf8");
  const parsed = parseImportDocument(relPath, markdown);
  const destinationPath = path.join(contentRoot, relPath);
  const destinationSectionsPath = `${destinationPath}.sections`;
  const stagingRoot = path.join(contentRoot, ".import-tmp", randomUUID());
  const stagedDocPath = path.join(stagingRoot, relPath);
  const stagedSectionsPath = `${stagedDocPath}.sections`;

  await mkdir(path.dirname(stagedDocPath), { recursive: true });

  // Create skeleton via DocumentSkeleton
  const skeleton = DocumentSkeleton.createEmpty(relPath, stagingRoot);

  if (parsed.sections.length === 0) {
    // No headings — root-only skeleton, write root body
    await skeleton.persist();
    const rootEntry = skeleton.resolveRoot();
    await mkdir(path.dirname(rootEntry.absolutePath), { recursive: true });
    await writeFile(rootEntry.absolutePath, markdown, "utf8");
  } else {
    // Add headed sections (correctly nests by level via addSectionsFromRootSplit)
    const added = skeleton.addSectionsFromRootSplit(
      parsed.sections.map(s => ({ heading: s.heading, level: s.depth, body: s.body })),
    );
    await skeleton.persist();

    // Write body files for each added section
    for (const entry of added) {
      if (entry.isSubSkeleton) continue;
      const section = parsed.sections.find(s => s.heading === entry.heading);
      if (!section) continue;
      await mkdir(path.dirname(entry.absolutePath), { recursive: true });
      await writeFile(entry.absolutePath, section.body, "utf8");
    }

    // Also write root body (content before first heading, if any)
    // The root entry exists because addSectionsFromRootSplit preserves root
    const rootEntry = skeleton.resolveRoot();
    if (rootEntry && !rootEntry.isSubSkeleton) {
      await mkdir(path.dirname(rootEntry.absolutePath), { recursive: true });
      await writeFile(rootEntry.absolutePath, "", "utf8");
    }
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await rm(destinationPath, { force: true });
  await rm(destinationSectionsPath, { recursive: true, force: true });

  await rename(stagedDocPath, destinationPath);
  await rename(stagedSectionsPath, destinationSectionsPath);

  await rm(stagingRoot, { recursive: true, force: true });
}

export async function importContent(sourceRoot: string, contentRoot: string): Promise<ContentImportSummary> {
  const summary: ContentImportSummary = { imported: 0, failed: 0, skipped: 0, errors: [] };

  try {
    if (!(await isDirectoryEmpty(contentRoot))) {
      summary.skipped += 1;
      return summary;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(contentRoot, { recursive: true });
    } else {
      throw error;
    }
  }

  const ignorePatterns = await readImportIgnorePatterns(sourceRoot);
  const markdownFiles = await collectImportMarkdownFiles(sourceRoot, ignorePatterns);
  for (const relPath of markdownFiles) {
    try {
      await importOneFile(sourceRoot, contentRoot, relPath);
      summary.imported += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
