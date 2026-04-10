import path from "node:path";
import { readdir } from "node:fs/promises";
import { getContentRoot, getContentGitPrefix, getDataRoot, getSessionDocsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { assessSkeleton, type SkeletonAssessment } from "../../storage/recovery-layers.js";
import { resolveSkeletonPath, DocumentSkeleton, parseSkeletonToEntries } from "../../storage/document-skeleton.js";
import { normalizeDocPath } from "../../storage/path-utils.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { gitExec } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";
import type {
  DiagHealthCheck,
  DiagRestoreProvenance,
  DiagSectionLayerInfo,
  DiagSummary,
} from "./types.js";

export interface RecursiveStructuralEntry {
  sectionFile: string;
  headingPath: string[];
  absolutePath: string;
  isSubSkeleton: boolean;
}

export interface RecursiveContentEntry {
  headingPath: string[];
  absolutePath: string;
}

export interface RecursiveSkeletonView {
  allStructuralEntries(): RecursiveStructuralEntry[];
  allContentEntries(): RecursiveContentEntry[];
  forEachSection(
    cb: (
      heading: string,
      level: number,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
    ) => void,
  ): void;
  forEachNode(
    cb: (
      heading: string,
      level: number,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
      isSubSkeleton: boolean,
    ) => void,
  ): void;
}

export interface HistoricalRecursiveView {
  topLevelEntries: number;
  recursiveContentSections: number;
  contentHeadingKeys: string[];
}

export interface DocumentDiagnosticsContext {
  docPath: string;
  dataRoot: string;
  contentRoot: string;
  overlayContentRoot: string;
  fragmentsRoot: string;
  contentGitPrefix: string;
  normalizedDocPath: string;
  canonicalSkeletonPath: string;
  canonicalSectionsDir: string;
  overlaySkeletonPath: string;
  overlaySectionsDir: string;
  fragmentDir: string;
  checks: DiagHealthCheck[];
  sections: DiagSectionLayerInfo[];
  summary: DiagSummary;
  restoreProvenance: DiagRestoreProvenance;
  skeletonAssessment?: SkeletonAssessment | null;
  recursiveSkeleton?: RecursiveSkeletonView | null;
  recursiveSkeletonLoadError?: Error | null;
  pushCheck: (category: string, name: string, pass: boolean, detail?: string) => void;
}

export function createDocumentDiagnosticsContext(docPath: string): DocumentDiagnosticsContext {
  const dataRoot = getDataRoot();
  const contentRoot = getContentRoot();
  const overlayContentRoot = getSessionDocsContentRoot();
  const fragmentsRoot = getSessionFragmentsRoot();
  const contentGitPrefix = getContentGitPrefix();
  const normalizedDocPath = normalizeDocPath(docPath);
  const canonicalSkeletonPath = resolveSkeletonPath(docPath, contentRoot);
  const canonicalSectionsDir = `${canonicalSkeletonPath}.sections`;
  const overlaySkeletonPath = resolveSkeletonPath(docPath, overlayContentRoot);
  const overlaySectionsDir = `${overlaySkeletonPath}.sections`;
  const fragmentDir = path.resolve(fragmentsRoot, ...normalizedDocPath.split("/"));
  const checks: DiagHealthCheck[] = [];

  return {
    docPath,
    dataRoot,
    contentRoot,
    overlayContentRoot,
    fragmentsRoot,
    contentGitPrefix,
    normalizedDocPath,
    canonicalSkeletonPath,
    canonicalSectionsDir,
    overlaySkeletonPath,
    overlaySectionsDir,
    fragmentDir,
    checks,
    sections: [],
    summary: {
      top_level_entries: null,
      recursive_structural_entries: null,
      recursive_content_sections: null,
      recursive_subskeleton_parents: null,
      recursive_max_depth: null,
    },
    restoreProvenance: {
      current_head_sha: null,
      last_restore_commit_sha: null,
      last_restore_target_sha: null,
      target_top_level_entries: null,
      target_recursive_content_sections: null,
      recursive_content_match: null,
      current_only_heading_keys: [],
      target_only_heading_keys: [],
    },
    pushCheck: (category: string, name: string, pass: boolean, detail?: string) => {
      checks.push({ category, name, pass, detail });
    },
  };
}

export async function ensureTopLevelSkeletonAssessment(
  ctx: DocumentDiagnosticsContext,
): Promise<SkeletonAssessment> {
  if (ctx.skeletonAssessment !== undefined && ctx.skeletonAssessment !== null) return ctx.skeletonAssessment;
  const assessment = await assessSkeleton(ctx.canonicalSkeletonPath, ctx.canonicalSectionsDir);
  ctx.skeletonAssessment = assessment;
  return assessment;
}

export async function ensureRecursiveSkeleton(
  ctx: DocumentDiagnosticsContext,
): Promise<RecursiveSkeletonView> {
  if (ctx.recursiveSkeleton) return ctx.recursiveSkeleton;
  if (ctx.recursiveSkeletonLoadError) throw ctx.recursiveSkeletonLoadError;
  try {
    const skeleton = await DocumentSkeleton.fromDisk(ctx.docPath, ctx.contentRoot, ctx.contentRoot);
    ctx.recursiveSkeleton = skeleton as RecursiveSkeletonView;
    return ctx.recursiveSkeleton;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    ctx.recursiveSkeletonLoadError = error;
    throw error;
  }
}

export function collectDuplicateFragmentKeyDetails(
  skeleton: Pick<RecursiveSkeletonView, "forEachSection">,
): string[] {
  const seen = new Map<string, { sectionFile: string; headingPath: string[] }>();
  const duplicates: string[] = [];
  skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    const fragmentKey = fragmentKeyFromSectionFile(
      sectionFile,
      level === 0 && heading === "" && headingPath.length === 0,
    );
    const existing = seen.get(fragmentKey);
    if (!existing) {
      seen.set(fragmentKey, { sectionFile, headingPath: [...headingPath] });
      return;
    }
    const existingLabel = existing.headingPath.length > 0 ? existing.headingPath.join(" > ") : "(before first heading)";
    const incomingLabel = headingPath.length > 0 ? headingPath.join(" > ") : "(before first heading)";
    duplicates.push(
      `${fragmentKey}: ${existing.sectionFile} [${existingLabel}] conflicts with ${sectionFile} [${incomingLabel}]`,
    );
  });
  return duplicates;
}

export function collectDuplicateSectionFileDetails(
  skeleton: Pick<RecursiveSkeletonView, "allStructuralEntries">,
): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const entry of skeleton.allStructuralEntries()) {
    const label = entry.headingPath.length > 0 ? entry.headingPath.join(" > ") : "(before first heading)";
    const existing = seen.get(entry.sectionFile);
    if (!existing) {
      seen.set(entry.sectionFile, label);
      continue;
    }
    duplicates.push(`${entry.sectionFile}: [${existing}] conflicts with [${label}]`);
  }
  return duplicates;
}

export async function listRecursiveMdFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listRecursiveMdFiles(full, rel));
      continue;
    }
    if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out.sort();
}

export async function gitShowFileOrNullAtSha(
  ctx: DocumentDiagnosticsContext,
  sha: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return await gitExec(["show", `${sha}:${relativePath}`], ctx.dataRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("does not exist") || msg.includes("exists on disk, but not in")) return null;
    throw err;
  }
}

export async function loadHistoricalRecursiveView(
  ctx: DocumentDiagnosticsContext,
  targetSha: string,
): Promise<HistoricalRecursiveView | null> {
  const skeletonGitPath = `${ctx.contentGitPrefix}/${ctx.normalizedDocPath}`;
  const rootContent = await gitShowFileOrNullAtSha(ctx, targetSha, skeletonGitPath);
  if (rootContent === null) return null;

  let topLevelEntries = 0;
  const contentHeadingKeys = new Set<string>();

  const walk = async (
    gitPath: string,
    parentHeadingPath: string[],
    raw: string,
    isTopLevel: boolean,
  ): Promise<void> => {
    const entries = parseSkeletonToEntries(raw);
    if (isTopLevel) topLevelEntries = entries.length;
    for (const entry of entries) {
      const isBfh = entry.level === 0 && entry.heading === "";
      const headingPath = isBfh ? [...parentHeadingPath] : [...parentHeadingPath, entry.heading];
      contentHeadingKeys.add(SectionRef.headingKey(headingPath));
      const childGitPath = `${gitPath}.sections/${entry.sectionFile}`;
      const childContent = await gitShowFileOrNullAtSha(ctx, targetSha, childGitPath);
      if (!childContent) continue;
      if (parseSkeletonToEntries(childContent).length === 0) continue;
      await walk(childGitPath, headingPath, childContent, false);
    }
  };

  await walk(skeletonGitPath, [], rootContent, true);
  return {
    topLevelEntries,
    recursiveContentSections: contentHeadingKeys.size,
    contentHeadingKeys: [...contentHeadingKeys].sort(),
  };
}
