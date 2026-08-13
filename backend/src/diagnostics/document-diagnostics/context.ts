import path from "node:path";
import { readdir } from "node:fs/promises";
import { getContentRoot, getContentGitPrefix, getDataRoot } from "../../storage/data-root.js";
import { assessSkeleton, type SkeletonAssessment } from "../../storage/skeleton-assessment.js";
import { resolveSkeletonPath, parseSkeletonToEntries, type FlatEntry } from "../../storage/document-skeleton.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { docPathToContentRelativeFsPath } from "../../storage/path-utils.js";
import { DocPath, HeadingLevel, type ProposalId } from "../../types/shared.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { findInProgressProposalForDoc } from "../../storage/proposal-repository.js";
import { gitExec } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";
import { isBodyHolderShape, isDocumentBeforeFirstHeading } from "../../storage/section-shape.js";
import type {
  DiagBackendState,
  DiagHealthCheck,
  DiagRestoreProvenance,
  DiagSectionLayerInfo,
  DiagSummary,
} from "./types.js";

export async function resolveDiagnosticsDraftProposalId(docPath: DocPath): Promise<ProposalId | null> {
  const session = lookupDocSession(docPath);
  const fromSession = session?.generator.getCurrentProposalId() ?? null;
  if (fromSession) return fromSession;
  const inprogress = await findInProgressProposalForDoc(docPath);
  return inprogress?.id ?? null;
}

export interface RecursiveStructuralEntry {
  sectionFile: string;
  heading: string;
  headingLevel: HeadingLevel;
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
      headingLevel: HeadingLevel,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
    ) => void,
  ): void;
  forEachNode(
    cb: (
      heading: string,
      headingLevel: HeadingLevel,
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
  docPath: DocPath;
  dataRoot: string;
  contentRoot: string;
  contentGitPrefix: string;
  contentRelativeFsPath: string;
  canonicalSkeletonPath: string;
  canonicalSectionsDir: string;
  checks: DiagHealthCheck[];
  sections: DiagSectionLayerInfo[];
  summary: DiagSummary;
  restoreProvenance: DiagRestoreProvenance;
  backendStates: DiagBackendState[];
  skeletonAssessment?: SkeletonAssessment | null;
  recursiveSkeleton?: RecursiveSkeletonView | null;
  recursiveSkeletonLoadError?: Error | null;
  pushCheck: (category: string, name: string, pass: boolean, detail?: string) => void;
}

export function createDocumentDiagnosticsContext(docPath: DocPath): DocumentDiagnosticsContext {
  const dataRoot = getDataRoot();
  const contentRoot = getContentRoot();
  const contentGitPrefix = getContentGitPrefix();
  const contentRelativeFsPath = docPathToContentRelativeFsPath(DocPath.parse(docPath));
  const canonicalSkeletonPath = resolveSkeletonPath(docPath, contentRoot);
  const canonicalSectionsDir = `${canonicalSkeletonPath}.sections`;
  const checks: DiagHealthCheck[] = [];

  return {
    docPath,
    dataRoot,
    contentRoot,
    contentGitPrefix,
    contentRelativeFsPath,
    canonicalSkeletonPath,
    canonicalSectionsDir,
    checks,
    sections: [],
    summary: {
      top_level_entries: null,
      recursive_structural_entries: null,
      recursive_content_sections: null,
      recursive_subskeleton_parents: null,
      recursive_max_heading_path_length: null,
      physical_section_count: null,
      logical_section_count: null,
      api_section_count: null,
    },
    backendStates: [],
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
    const entries = await new ContentLayer(ctx.contentRoot).listCanonicalEntries(ctx.docPath);
    ctx.recursiveSkeleton = recursiveSkeletonViewFromFlatEntries(entries);
    return ctx.recursiveSkeleton;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    ctx.recursiveSkeletonLoadError = error;
    throw error;
  }
}

function recursiveSkeletonViewFromFlatEntries(entries: FlatEntry[]): RecursiveSkeletonView {
  return {
    allStructuralEntries() {
      return entries.map((e) => ({
        sectionFile: e.sectionFile,
        heading: e.heading,
        headingLevel: e.headingLevel,
        headingPath: [...e.headingPath],
        absolutePath: e.absolutePath,
        isSubSkeleton: e.isSubSkeleton,
      }));
    },
    allContentEntries() {
      return entries
        .filter((e) => !e.isSubSkeleton)
        .map((e) => ({ headingPath: [...e.headingPath], absolutePath: e.absolutePath }));
    },
    forEachSection(cb) {
      for (const e of entries) {
        if (!e.isSubSkeleton) cb(e.heading, e.headingLevel, e.sectionFile, e.headingPath, e.absolutePath);
      }
    },
    forEachNode(cb) {
      for (const e of entries) {
        cb(e.heading, e.headingLevel, e.sectionFile, e.headingPath, e.absolutePath, e.isSubSkeleton);
      }
    },
  };
}

export function collectDuplicateFragmentKeyDetails(
  skeleton: Pick<RecursiveSkeletonView, "forEachSection">,
): string[] {
  const seen = new Map<string, { sectionFile: string; headingPath: string[] }>();
  const duplicates: string[] = [];
  skeleton.forEachSection((heading, headingLevel, sectionFile, headingPath) => {
    const fragmentKey = fragmentKeyFromSectionFile(
      sectionFile,
      isDocumentBeforeFirstHeading({ heading, headingLevel, headingPath }),
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

/**
 * Report every heading path that appears more than once among the recursive
 * physical content sections — the illegal shape a duplicate check must expose,
 * INDEPENDENT of any heading-key-keyed map (which silently collapses duplicates
 * into a single logical row). Iteration is over raw recursive entries so a
 * physical duplicate is reported with all involved `sectionFile` ids and
 * fragment keys, matching what the operator needs to disambiguate the repair.
 */
export function collectDuplicateHeadingPathDetails(
  skeleton: Pick<RecursiveSkeletonView, "forEachSection">,
): string[] {
  const groups = new Map<string, Array<{ sectionFile: string; fragmentKey: string; headingPath: string[]; heading: string; headingLevel: HeadingLevel }>>();
  skeleton.forEachSection((heading, headingLevel, sectionFile, headingPath) => {
    const key = SectionRef.headingKey(headingPath);
    const fragmentKey = fragmentKeyFromSectionFile(
      sectionFile,
      isDocumentBeforeFirstHeading({ heading, headingLevel, headingPath }),
    );
    const list = groups.get(key);
    const row = { sectionFile, fragmentKey, headingPath: [...headingPath], heading, headingLevel };
    if (list) list.push(row);
    else groups.set(key, [row]);
  });
  const duplicates: string[] = [];
  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    const label = rows[0].headingPath.length > 0 ? rows[0].headingPath.join(" > ") : "(before first heading)";
    const memberList = rows
      .map((r) => `${r.sectionFile} (${r.fragmentKey})`)
      .join(", ");
    duplicates.push(`${label}: ${memberList}`);
  }
  return duplicates;
}

/**
 * Detect the illegal skeleton shape where two direct-child nodes of the same
 * parent share a heading, at any depth. Distinct from `collectDuplicateHeading
 * PathDetails` (which reports identical full paths anywhere in the tree): this
 * one walks each sibling-list independently, so a repeated heading buried
 * inside a nested sub-skeleton is caught before the flat heading-key map masks
 * it. Duplicate document-level BFH / body-holder roots and duplicate named
 * sibling headings are reported as distinct groups so the operator can tell
 * which shape they are looking at.
 */
export function collectDuplicateSiblingHeadingDetails(
  skeleton: Pick<RecursiveSkeletonView, "allStructuralEntries">,
): string[] {
  interface Row { sectionFile: string; heading: string; headingLevel: HeadingLevel; headingPath: string[]; isBodyHolder: boolean }
  const groups = new Map<string, Row[]>();
  for (const entry of skeleton.allStructuralEntries()) {
    const isBodyHolder = isBodyHolderShape(entry);
    // Parent path = the sibling-list this node belongs to.
    // A body-holder's `headingPath` already equals its parent's headingPath (Option A
    // does not push a segment for BFH-shape entries); a real named node's parent is
    // its own path minus the last segment.
    const parentPath = isBodyHolder ? [...entry.headingPath] : entry.headingPath.slice(0, -1);
    const parentKey = parentPath.join(">>");
    // Group by (parent, heading text, level, body-holder-shape) — the last flag
    // segregates duplicate body-holders from a same-heading named-sibling duplicate
    // so operator-facing details stay unambiguous.
    const groupKey = `${parentKey}||${entry.heading}@${entry.headingLevel}@${isBodyHolder ? "bh" : "h"}`;
    const row: Row = {
      sectionFile: entry.sectionFile,
      heading: entry.heading,
      headingLevel: entry.headingLevel,
      headingPath: [...entry.headingPath],
      isBodyHolder,
    };
    const list = groups.get(groupKey);
    if (list) list.push(row);
    else groups.set(groupKey, [row]);
  }
  const details: string[] = [];
  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    const first = rows[0];
    const parentPath = first.isBodyHolder ? first.headingPath : first.headingPath.slice(0, -1);
    const parentLabel = parentPath.length > 0 ? parentPath.join(" > ") : "(document root)";
    let identityLabel: string;
    if (first.isBodyHolder) {
      identityLabel = parentPath.length === 0
        ? "duplicate document-level before-first-heading root"
        : `duplicate body-holder for "${parentPath[parentPath.length - 1]}"`;
    } else {
      identityLabel = `duplicate sibling heading "${first.heading}" (heading level ${first.headingLevel})`;
    }
    const memberList = rows
      .map((r) => `${r.sectionFile} (${fragmentKeyFromSectionFile(r.sectionFile, r.isBodyHolder && r.headingPath.length === 0)})`)
      .join(", ");
    details.push(`Under ${parentLabel}: ${identityLabel} — ${memberList}`);
  }
  return details;
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
  const skeletonGitPath = `${ctx.contentGitPrefix}/${ctx.contentRelativeFsPath}`;
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
      const isBfh = isBodyHolderShape(entry);
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
