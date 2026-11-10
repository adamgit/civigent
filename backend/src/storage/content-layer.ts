import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DocumentSkeleton,
  DocumentSkeletonInternal,
  resolveSkeletonPath,
  skeletonFileExists,
  skeletonFileExistsSync,
  tombstoneFileExistsSync,
  writeTombstoneMarker,
  generateSectionFilename,
  generateBeforeFirstHeadingFilename,
  headingsEqual,
  listSkeletonEntriesAtRoot,
  type ContentEntry,
  type FlatEntry,
  type HeadingRemovalEffect,
  type HeadingRemovalMergeTarget,
  type MutationTransactionContext,
  type ProposalDocumentState,
  type SectionInsertPlacement,
  type SectionNodePlacement,
  type SkeletonNode,
  type StructuralMutationPlan,
} from "./document-skeleton.js";
import { docPathToContentRelativeFsPath } from "./path-utils.js";
import { directoryExists, directoryExistsSync, pathExists, readFileIfExistsSync } from "./fs-primitives.js";
import { staleHeadingPath } from "./skeleton-errors.js";
import type { DocStructureNode } from "../types/shared.js";
import { DocPath, HeadingLevel } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { bodyFromDisk, bodyFromParser, stripHeadingFromFragment, buildFragmentContent, assembleFragments, fragmentFromBodyHolder, stripLeadingNewlines, appendToBody, fragmentFromExternalContent, sectionWriteInputFromExternal, type SectionBody, type FragmentContent, type SectionBodyWithPotentialSubsections } from "./section-formatting.js";
import { isBodyHolderShape, isDocumentBeforeFirstHeading, parsedSectionIsHeadless } from "./section-shape.js";
import type { ParsedSection } from "./markdown-sections.js";
import {
  findDuplicateHeadingAddresses,
  headingPathsAddressEqual,
  payloadChildParentPath,
} from "./heading-addressability.js";

async function writeBodyFile(entry: ContentEntry | FlatEntry, content: string): Promise<void> {
  if ("kind" in entry) {
    if (entry.kind !== "content_entry") {
      throw new Error("writeBodyFile only accepts content entries.");
    }
  } else if (entry.isSubSkeleton) {
    return;
  }
  if (getParser().containsHeadings(content)) {
    throw new MultiSectionContentError(
      `writeBodyFile(${entry.absolutePath}) was given content containing embedded ` +
      `heading(s) — a body file may never carry a heading line. Use the parser-driven ` +
      `upsertSection(...) path, which promotes embedded headings into real sections.`,
    );
  }
  const normalized = jsonToMarkdown(markdownToJSON(content));
  await mkdir(path.dirname(entry.absolutePath), { recursive: true });
  await writeFile(entry.absolutePath, normalized, "utf8");
}

function resolveDocSkeletonPath(contentRoot: string, docPath: DocPath): string {
  return path.resolve(contentRoot, ...docPathToContentRelativeFsPath(DocPath.parse(docPath)).split("/"));
}

function flatEntryFromContentEntry(entry: ContentEntry): FlatEntry {
  return {
    headingPath: [...entry.headingPath],
    heading: entry.heading,
    headingLevel: entry.headingLevel,
    sectionFile: entry.sectionFile,
    absolutePath: entry.absolutePath,
    isSubSkeleton: false,
  };
}

/** Express a completed heading removal in the section-upsert result shape the
 *  parser-driven write path returns (a body-only write to a headed section IS a
 *  heading removal). Written entries are the relocated descendants plus the merge
 *  target when its body was written. */
function upsertResultFromHeadingRemoval(
  effect: HeadingRemovalEffect,
  deletedEntry: ContentEntry,
): UpsertSectionFromMarkdownDetailedResult {
  const writtenEntries: FlatEntry[] = [];
  for (const { oldEntry, newEntry } of effect.preservedDescendants) {
    if (oldEntry.absolutePath !== newEntry.absolutePath) writtenEntries.push(newEntry);
  }
  if (effect.mergeTarget && effect.mergeTarget.mergedBody !== null && !effect.dissolvedBfh) {
    writtenEntries.push(effect.mergeTarget.newEntry);
  }
  const removedContentEntries = effect.removedTargetEntries.filter((e) => !e.isSubSkeleton);
  if (effect.dissolvedBfh) removedContentEntries.push(effect.dissolvedBfh);
  return {
    writtenEntries,
    removedContentEntries,
    fragmentKeyRemaps: effect.fragmentKeyChanges,
    liveReloadEntries: [...writtenEntries],
    structureChanges: [{ oldEntry: flatEntryFromContentEntry(deletedEntry), newEntries: [] }],
  };
}

export type ParsedMarkdownRewriteSection = Readonly<{
  heading: string;
  headingLevel: HeadingLevel;
  body: string;
  headingPath: readonly string[];
}>;

interface RewriteTreeNode extends SkeletonNode {
  children: RewriteTreeNode[];
}

function headingPathKey(headingPath: readonly string[]): string {
  return SectionRef.headingKey([...headingPath]);
}

function singleSectionMarkdown(section: ParsedSection): string {
  return `${"#".repeat(section.headingLevel)} ${section.heading}\n\n${section.body as unknown as string}`;
}

function buildReplacementRoots(
  targetParentPath: readonly string[],
  parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  existingContentByResultingPath: ReadonlyMap<string, string> = new Map(),
): {
  replacementRoots: RewriteTreeNode[];
  bodyByResultingHeadingPath: Map<string, string>;
} {
  const replacementRoots: RewriteTreeNode[] = [];
  const bodyByResultingHeadingPath = new Map<string, string>();
  const nodesByParsedHeadingPath = new Map<string, RewriteTreeNode>();
  const resultingKeyByNode = new Map<RewriteTreeNode, string>();

  const duplicateParsedAddress = findDuplicateHeadingAddresses(
    parsedSections.map((section) => section.headingPath),
  )[0];
  if (duplicateParsedAddress) {
    throw new Error(
      `Parsed markdown contains duplicate heading path [${[...duplicateParsedAddress.path].join(" > ")}].`,
    );
  }

  for (const section of parsedSections) {
    const parsedHeadingPath = [...section.headingPath];
    const parsedKey = headingPathKey(parsedHeadingPath);

    const resultingHeadingPath = [...targetParentPath, ...parsedHeadingPath];
    const resultingKey = headingPathKey(resultingHeadingPath);

    const node: RewriteTreeNode = {
      heading: parsedHeadingPath.length === 0 ? "" : section.heading,
      headingLevel: section.headingLevel,
      sectionFile: parsedHeadingPath.length === 0
        ? generateBeforeFirstHeadingFilename()
        : generateSectionFilename(section.heading),
      children: [],
    };
    nodesByParsedHeadingPath.set(parsedKey, node);
    resultingKeyByNode.set(node, resultingKey);

    bodyByResultingHeadingPath.set(resultingKey, section.body);

    if (parsedHeadingPath.length <= 1) {
      replacementRoots.push(node);
      continue;
    }

    const parentParsedHeadingPath = parsedHeadingPath.slice(0, -1);
    const parent = nodesByParsedHeadingPath.get(headingPathKey(parentParsedHeadingPath));
    if (!parent) {
      throw new Error(
        `Parsed markdown is structurally inconsistent: missing parent [${parentParsedHeadingPath.join(" > ")}] ` +
        `for section [${parsedHeadingPath.join(" > ")}].`,
      );
    }
    parent.children.push(node);
  }

  for (const [node, resultingKey] of resultingKeyByNode) {
    const existingFile = existingContentByResultingPath.get(resultingKey);
    if (existingFile === undefined) continue;
    if (node.children.length === 0) {
      node.sectionFile = existingFile;
    } else if (!node.children.some((c) => isBodyHolderShape(c))) {
      node.children.unshift({ heading: "", headingLevel: HeadingLevel.beforeFirstHeading, sectionFile: existingFile, children: [] });
    }
  }

  return { replacementRoots, bodyByResultingHeadingPath };
}

function buildBodyWritesForReplacement(
  docPath: DocPath,
  added: FlatEntry[],
  bodyByResultingHeadingPath: Map<string, string>,
): StructuralMutationPlan["bodyWrites"] {
  const contentEntryByHeadingPath = new Map<string, FlatEntry>();
  for (const entry of added) {
    if (entry.isSubSkeleton) continue;
    const key = headingPathKey(entry.headingPath);
    if (contentEntryByHeadingPath.has(key)) {
      throw new Error(
        `Structural rewrite for "${docPath}" produced duplicate content entries at [${entry.headingPath.join(" > ")}].`,
      );
    }
    contentEntryByHeadingPath.set(key, entry);
  }

  if (contentEntryByHeadingPath.size !== bodyByResultingHeadingPath.size) {
    throw new Error(
      `Structural rewrite for "${docPath}" produced ${contentEntryByHeadingPath.size} content entries ` +
      `for ${bodyByResultingHeadingPath.size} parsed sections.`,
    );
  }

  const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
  for (const [headingKey, body] of bodyByResultingHeadingPath) {
    const entry = contentEntryByHeadingPath.get(headingKey);
    if (!entry) {
      throw new Error(
        `Structural rewrite for "${docPath}" could not resolve a body target for parsed heading key "${headingKey}".`,
      );
    }
    bodyWrites.push({ absolutePath: entry.absolutePath, content: body });
  }

  return bodyWrites;
}

function placementParentPath(placement: SectionNodePlacement): string[] {
  switch (placement.kind) {
    case "replace":
      return placement.headingPath.slice(0, -1);
    case "only-child":
      return [...placement.parentPath];
    default:
      return placement.anchorHeadingPath.slice(0, -1);
  }
}

function planSiblingInstall(
  ctx: MutationTransactionContext,
  docPath: DocPath,
  placement: SectionNodePlacement,
  parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  existingContentByResultingPath?: ReadonlyMap<string, string>,
): { added: FlatEntry[]; bodyWrites: StructuralMutationPlan["bodyWrites"] } {
  const parent = placementParentPath(placement);
  const { replacementRoots, bodyByResultingHeadingPath } = buildReplacementRoots(
    parent,
    parsedSections,
    existingContentByResultingPath,
  );
  ctx.addBodyHoldersToParents(replacementRoots);
  ctx.placeSectionNodes(placement, replacementRoots);

  const parentSkeletonPath = ctx.resolveSkeletonPathFor(parent);
  const added: FlatEntry[] = [];
  for (const node of replacementRoots) {
    added.push(...ctx.flattenNode(node, parent, parentSkeletonPath));
  }
  return { added, bodyWrites: buildBodyWritesForReplacement(docPath, added, bodyByResultingHeadingPath) };
}

/** Real (headed) child headings of `parentPath`, in walk order. */
function realSiblingHeadings(skeleton: DocumentSkeleton, parentPath: readonly string[]): string[] {
  const entries = parentPath.length === 0
    ? skeleton.allStructuralEntries().filter((e) => e.headingPath.length === 1 && !e.isSubSkeleton)
    : skeleton.subtreeEntries([...parentPath]).filter((e) => e.headingPath.length === parentPath.length + 1);
  return entries.map((e) => e.headingPath[parentPath.length]);
}

/** Real (headed) direct children of `parentPath`, in walk order. Body holders excluded. */
function planPayloadChildMoves(
  ref: SectionRef,
  headedSections: ReadonlyArray<ParsedSection>,
  skeleton: DocumentSkeleton,
): Array<{ childSectionFile: string; newParentPath: string[] }> {
  const parentPrefix = ref.headingPath.slice(0, -1);
  const createdPaths = headedSections
    .slice(1)
    .map((parsed) => [...parentPrefix, ...parsed.headingPath])
    .filter((resultingPath) => !skeleton.has(resultingPath));
  const destinationChildren = new Map<string, Array<{ heading: string; sectionFile: string }>>();
  for (const createdPath of createdPaths) {
    const parentKey = headingPathKey(createdPath.slice(0, -1));
    const siblings = destinationChildren.get(parentKey) ?? [];
    siblings.push({ heading: createdPath[createdPath.length - 1]!, sectionFile: "" });
    destinationChildren.set(parentKey, siblings);
  }

  const moves: Array<{ childSectionFile: string; newParentPath: string[] }> = [];
  for (const child of realDirectChildEntries(skeleton, ref.headingPath)) {
    const newParentPath = payloadChildParentPath(parentPrefix, headedSections, child.headingLevel);
    if (newParentPath === null) continue;
    if (!createdPaths.some((createdPath) => headingPathsAddressEqual(createdPath, newParentPath))) continue;
    const parentKey = headingPathKey(newParentPath);
    const siblings = destinationChildren.get(parentKey) ?? [];
    const conflict = siblings.find((sibling) =>
      headingPathsAddressEqual([...newParentPath, sibling.heading], [...newParentPath, child.heading]),
    );
    if (conflict) {
      throw new DuplicateSiblingHeadingError({
        operation: "move",
        docPath: ref.docPath,
        parentHeadingPath: newParentPath,
        proposedHeading: child.heading,
        proposedHeadingLevel: child.headingLevel,
        conflictingSectionFile: conflict.sectionFile,
        targetSectionFile: child.sectionFile,
      });
    }
    siblings.push({ heading: child.heading, sectionFile: child.sectionFile });
    destinationChildren.set(parentKey, siblings);
    moves.push({ childSectionFile: child.sectionFile, newParentPath });
  }
  return moves;
}

function realDirectChildEntries(skeleton: DocumentSkeleton, parentPath: readonly string[]): FlatEntry[] {
  return skeleton.allStructuralEntries().filter((entry) =>
    entry.headingPath.length === parentPath.length + 1
    && headingPathsAddressEqual(entry.headingPath.slice(0, parentPath.length), parentPath)
    && !isBodyHolderShape(entry)
  );
}

/** Keep the claim on content entries an install created, even when the fill
 *  that followed wrote nothing over them. */
function withInstalledContentEntries(
  result: UpsertSectionFromMarkdownDetailedResult,
  installed: readonly FlatEntry[],
): UpsertSectionFromMarkdownDetailedResult {
  const writtenEntries = [...result.writtenEntries];
  const alreadyAccountedFor = new Set([
    ...writtenEntries.map((e) => e.absolutePath),
    ...result.removedContentEntries.map((e) => e.absolutePath),
  ]);
  for (const entry of installed) {
    if (entry.isSubSkeleton) continue;
    if (alreadyAccountedFor.has(entry.absolutePath)) continue;
    alreadyAccountedFor.add(entry.absolutePath);
    writtenEntries.push(entry);
  }
  return { ...result, writtenEntries };
}

export class SectionNotFoundError extends Error {}
export class DocumentNotFoundError extends Error {}
export class DirectoryAtDocPathError extends Error {}

function directoryAtDocPathMessage(docPath: DocPath): string {
  return `Path "${docPath}" is shaped like a document (ends in ".md") and is treated as one, but a directory exists at this path — an illegal folder name. Folder names may never end in ".md"; this directory was created as a side effect of a document path with an interior ".md" segment (e.g. "/foo.md/bar.md"). The documents inside it are intact; rename or delete them via their full document paths to remove it.`;
}

async function throwForAbsentDocument(docPath: DocPath, contentRoots: string[]): Promise<never> {
  for (const contentRoot of contentRoots) {
    if (await directoryExists(resolveSkeletonPath(docPath, contentRoot))) {
      throw new DirectoryAtDocPathError(directoryAtDocPathMessage(docPath));
    }
  }
  throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
}
export class DocumentAssemblyError extends Error {}
export class MultiSectionContentError extends Error {}

export class ProposalSectionReorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalSectionReorderError";
  }
}

export class DuplicateSiblingHeadingError extends Error {
  readonly operation: "rename" | "move" | "rewrite" | "insert";
  readonly docPath: DocPath;
  readonly parentHeadingPath: readonly string[];
  readonly proposedHeading: string;
  readonly proposedHeadingLevel: number;
  readonly conflictingSectionFile: string;
  readonly targetSectionFile: string;
  constructor(args: {
    operation: "rename" | "move" | "rewrite" | "insert";
    docPath: DocPath;
    parentHeadingPath: readonly string[];
    proposedHeading: string;
    proposedHeadingLevel: number;
    conflictingSectionFile: string;
    targetSectionFile: string;
  }) {
    const parentLabel = args.parentHeadingPath.length === 0
      ? "the document root"
      : `[${args.parentHeadingPath.join(" > ")}]`;
    const verb = args.operation === "move"
      ? "move"
      : args.operation === "rewrite"
        ? "rewrite"
        : args.operation === "insert"
          ? "insert"
          : "rename";
    const destinationLabel = args.operation === "move" ? "destination" : "sibling list";
    super(
      `Cannot ${verb} section: ${destinationLabel} under ${parentLabel} already ` +
      `contains a sibling with heading "${args.proposedHeading}" at heading level ${args.proposedHeadingLevel} in ${args.docPath}.`,
    );
    this.name = "DuplicateSiblingHeadingError";
    this.operation = args.operation;
    this.docPath = args.docPath;
    this.parentHeadingPath = args.parentHeadingPath;
    this.proposedHeading = args.proposedHeading;
    this.proposedHeadingLevel = args.proposedHeadingLevel;
    this.conflictingSectionFile = args.conflictingSectionFile;
    this.targetSectionFile = args.targetSectionFile;
  }
}

function assertNoDuplicateSiblingHeadingCollision(
  siblings: readonly SkeletonNode[],
  args: {
    operation: "rename" | "move" | "rewrite" | "insert";
    docPath: DocPath;
    parentHeadingPath: readonly string[];
    targetSectionFile: string;
    proposedHeading: string;
    proposedHeadingLevel: number;
  },
): void {
  const proposedPath = [...args.parentHeadingPath, args.proposedHeading];
  for (const sibling of siblings) {
    if (sibling.sectionFile === args.targetSectionFile) continue;
    const siblingPath = [...args.parentHeadingPath, sibling.heading];
    if (!headingPathsAddressEqual(proposedPath, siblingPath)) continue;
    throw new DuplicateSiblingHeadingError({
      operation: args.operation,
      docPath: args.docPath,
      parentHeadingPath: args.parentHeadingPath,
      proposedHeading: args.proposedHeading,
      proposedHeadingLevel: args.proposedHeadingLevel,
      conflictingSectionFile: sibling.sectionFile,
      targetSectionFile: args.targetSectionFile,
    });
  }
}

export interface SectionDiscoveryEntry {
  heading: string;
  headingPath: string[];
  absolutePath: string;
  bodySizeBytes: number;
}

export interface UpsertSectionFromMarkdownDetailedResult {
  writtenEntries: FlatEntry[];
  createdDocument?: boolean;
  removedContentEntries: FlatEntry[];
  fragmentKeyRemaps: StructuralMutationPlan["fragmentKeyRemaps"];
  liveReloadEntries: FlatEntry[];
  structureChanges: Array<{
    oldEntry: FlatEntry;
    newEntries: FlatEntry[];
  }>;
}

export async function recordOrphanedSectionRemovals(
  proposalId: string,
  docPath: DocPath,
  writeResult: UpsertSectionFromMarkdownDetailedResult,
): Promise<FlatEntry[]> {
  const survivingSectionFiles = new Set(writeResult.writtenEntries.map((e) => e.sectionFile));
  const orphanedRemovals = writeResult.removedContentEntries.filter(
    (e) => !survivingSectionFiles.has(e.sectionFile),
  );
  if (orphanedRemovals.length > 0) {
    const { recordDeletedSectionFiles } = await import("./proposal-repository.js");
    await recordDeletedSectionFiles(proposalId, docPath, orphanedRemovals.map((e) => e.sectionFile));
  }
  return orphanedRemovals;
}

import { getParser } from "./markdown-parser.js";


export class ContentLayer {
  readonly contentRoot: string;

  constructor(contentRoot: string) {
    this.contentRoot = contentRoot;
  }

  async getDocumentStructure(docPath: DocPath): Promise<DocStructureNode[]> {
    const skeleton = await this.readSkeleton(docPath);
    return skeleton.structure;
  }

  async getSectionList(docPath: DocPath): Promise<Array<{ heading: string; headingLevel: HeadingLevel; sectionFile: string; headingPath: string[] }>> {
    const skeleton = await this.readSkeleton(docPath);
    const sections: Array<{ heading: string; headingLevel: HeadingLevel; sectionFile: string; headingPath: string[] }> = [];
    skeleton.forEachVisibleSection((heading, headingLevel, sectionFile, headingPath) => {
      sections.push({ heading, headingLevel, sectionFile, headingPath: [...headingPath] });
    });
    return sections;
  }

  async listCanonicalEntries(docPath: DocPath): Promise<FlatEntry[]> {
    const entries = await listSkeletonEntriesAtRoot(docPath, this.contentRoot);
    return entries ?? [];
  }

  async getSectionDiscoveryList(docPath: DocPath): Promise<SectionDiscoveryEntry[]> {
    const skeleton = await this.readSkeleton(docPath);
    const baseEntries: Array<{ heading: string; headingPath: string[]; absolutePath: string }> = [];
    skeleton.forEachVisibleSection((heading, _level, _sectionFile, headingPath, absolutePath) => {
      baseEntries.push({
        heading,
        headingPath: [...headingPath],
        absolutePath,
      });
    });

    const sizedEntries = await Promise.all(
      baseEntries.map(async (entry) => {
        let bodySizeBytes = 0;
        try {
          const fileStat = await stat(entry.absolutePath);
          bodySizeBytes = fileStat.isFile() ? fileStat.size : 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        return {
          heading: entry.heading,
          headingPath: entry.headingPath,
          absolutePath: entry.absolutePath,
          bodySizeBytes,
        };
      }),
    );

    return sizedEntries;
  }

  private async readSkeleton(docPath: DocPath): Promise<DocumentSkeleton> {
    if (!skeletonFileExistsSync(docPath, this.contentRoot)) {
      if (directoryExistsSync(resolveSkeletonPath(docPath, this.contentRoot))) {
        throw new DirectoryAtDocPathError(directoryAtDocPathMessage(docPath));
      }
      throw new DocumentNotFoundError(`No skeleton found for document: ${docPath}`);
    }
    return DocumentSkeleton.fromSingleRoot(docPath, this.contentRoot);
  }

  async listHeadingPaths(docPath: DocPath): Promise<string[][]> {
    const skeleton = await this.readSkeleton(docPath);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    return paths;
  }

  sectionsDirectory(docPath: DocPath): string {
    return DocumentSkeleton.sectionsDir(docPath, this.contentRoot);
  }

  async resolveSectionPath(docPath: DocPath, headingPath: string[]): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      return skeleton.requireContentEntryByHeadingPath(headingPath).absolutePath;
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  async resolveSectionPathWithLevel(docPath: DocPath, headingPath: string[]): Promise<{ absolutePath: string; headingLevel: HeadingLevel }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireContentEntryByHeadingPath(headingPath);
      return { absolutePath: entry.absolutePath, headingLevel: entry.headingLevel };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  async resolveSectionFileId(docPath: DocPath, sectionFileId: string): Promise<{ absolutePath: string; headingPath: string[]; headingLevel: HeadingLevel }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireEntryBySectionFileId(sectionFileId);
      return { absolutePath: entry.absolutePath, headingPath: entry.headingPath, headingLevel: entry.headingLevel };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  async readSection(ref: SectionRef): Promise<SectionBody> {
    const skeleton = await this.readSkeleton(ref.docPath);
    let entry: ContentEntry;
    try {
      entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }

    const raw = readFileIfExistsSync(entry.absolutePath);
    if (raw === null) {
      throw new SectionNotFoundError(
        `Section not found: (${ref.docPath}, [${ref.headingPath.join(" > ")}]).`,
      );
    }
    return bodyFromDisk(raw);
  }

  async readSubtree(
    docPath: DocPath,
    headingPath: string[],
  ): Promise<Array<{ headingPath: string[]; heading: string; headingLevel: HeadingLevel; bodyContent: string }>> {
    const skeleton = await this.readSkeleton(docPath);
    const entries = skeleton.subtreeEntries(headingPath);
    const result: Array<{ headingPath: string[]; heading: string; headingLevel: HeadingLevel; bodyContent: string }> = [];
    for (const entry of entries) {
      const bodyContent = await this.readSection(new SectionRef(docPath, entry.headingPath));
      result.push({ headingPath: entry.headingPath, heading: entry.heading, headingLevel: entry.headingLevel, bodyContent });
    }
    return result;
  }

  async readSectionBatch(
    sections: SectionRef[],
  ): Promise<Map<string, string>> {
    const skeletonCache = new Map<string, DocumentSkeleton>();
    const result = new Map<string, string>();

    for (const ref of sections) {
      let skeleton = skeletonCache.get(ref.docPath);
      if (!skeleton) {
        skeleton = await this.readSkeleton(ref.docPath);
        skeletonCache.set(ref.docPath, skeleton);
      }

      const entry = skeleton.findContentEntryByHeadingPath(ref.headingPath);
      if (!entry) continue;

      try {
        const content = await readFile(entry.absolutePath, "utf8");
        result.set(ref.globalKey, content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    return result;
  }

  async writeSection(
    ref: SectionRef,
    content: string,
  ): Promise<void> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
    const body = stripHeadingFromFragment(fragmentFromExternalContent(content), entry.headingLevel);
    const hasHeadings = getParser().containsHeadings(body);
    if (hasHeadings) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — embedded heading(s) detected. ` +
        `Use ProposalShadowContentLayer.upsertSection(...) for arbitrary ` +
        `user markdown that may contain embedded headings; this strict primitive ` +
        `accepts body-only payloads only.`,
      );
    }
    await writeBodyFile(entry, body);
  }

  async readAllSections(docPath: DocPath): Promise<Map<string, SectionBody>> {
    const skeleton = await this.readSkeleton(docPath);
    const result = new Map<string, SectionBody>();
    const readTasks: Array<Promise<void>> = [];

    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, absolutePath) => {
      readTasks.push(
        (async () => {
          const key = SectionRef.headingKey(headingPath);
          try {
            result.set(key, bodyFromDisk(await readFile(absolutePath, "utf8")));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            throw new DocumentAssemblyError(
              `Section "${key}" in document "${docPath}" is referenced by the skeleton but has no body file in the active layer. ` +
              `This indicates data corruption — the skeleton and section files are out of sync.`,
              { cause: err },
            );
          }
        })(),
      );
    });

    await Promise.all(readTasks);
    return result;
  }

  async readAssembledDocument(docPath: DocPath): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);

    const bodyEntries: Array<{ heading: string; headingLevel: HeadingLevel; sectionFile: string; absolutePath: string; headingPath: string[] }> = [];
    skeleton.forEachVisibleSection((heading, headingLevel, sectionFile, headingPath, absolutePath) => {
      bodyEntries.push({ heading, headingLevel, sectionFile, absolutePath, headingPath: [...headingPath] });
    });

    if (bodyEntries.length === 0) {
      return "";
    }

    const parts: FragmentContent[] = [];

    for (const entry of bodyEntries) {
      let content: SectionBody | undefined;
      try {
        content = bodyFromDisk(await readFile(entry.absolutePath, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        throw new DocumentAssemblyError(
          `Skeleton integrity check failed for "${docPath}": section file "${entry.sectionFile}" is referenced by the skeleton but has no body file in the active layer. This indicates data corruption.`,
          { cause: err },
        );
      }

      if (content === undefined) continue;

      if (isDocumentBeforeFirstHeading(entry)) {
        const trimmed = stripLeadingNewlines(content);
        if (trimmed) parts.push(fragmentFromBodyHolder(trimmed));
      } else {
        parts.push(buildFragmentContent(content, entry.headingLevel, entry.heading));
      }
    }

    return assembleFragments(...parts);
  }
}

export class ProposalShadowContentLayer {
  readonly overlayRoot: string;
  readonly canonicalRoot: string;
  private readonly deletedSectionFilesProvider?: (docPath: DocPath) => Promise<ReadonlySet<string> | undefined>;

  constructor(
    overlayRoot: string,
    canonicalRoot: string,
    deletedSectionFilesProvider?: (docPath: DocPath) => Promise<ReadonlySet<string> | undefined>,
  ) {
    this.overlayRoot = overlayRoot;
    this.canonicalRoot = canonicalRoot;
    this.deletedSectionFilesProvider = deletedSectionFilesProvider;
  }

  async documentExists(docPath: DocPath): Promise<boolean> {
    return (await this.getDocumentState(docPath)) === "live";
  }

  async getDocumentState(docPath: DocPath): Promise<ProposalDocumentState> {
    if (this.overlayRoot !== this.canonicalRoot && tombstoneFileExistsSync(docPath, this.overlayRoot)) {
      return "tombstone";
    }
    if (skeletonFileExistsSync(docPath, this.overlayRoot)) return "live";
    if (skeletonFileExistsSync(docPath, this.canonicalRoot)) return "live";
    return "missing";
  }

  async createDocument(docPath: DocPath): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "live") {
      throw new Error(`Cannot create document "${docPath}" — it already exists.`);
    }
    if (state === "tombstone") {
      throw new Error(`Cannot create document "${docPath}" — it is pending deletion in this proposal.`);
    }
    await DocumentSkeletonInternal.createEmptySkeletonInRoot(
      docPath,
      this.overlayRoot,
    );
  }

  private async getWritableSkeleton(docPath: DocPath): Promise<DocumentSkeletonInternal> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await throwForAbsentDocument(docPath, [this.overlayRoot, this.canonicalRoot]);
    }
    return this.loadWritableSkeleton(docPath);
  }

  private async loadDeletedSectionFiles(docPath: DocPath): Promise<ReadonlySet<string> | undefined> {
    return this.overlayRoot !== this.canonicalRoot && this.deletedSectionFilesProvider
      ? await this.deletedSectionFilesProvider(docPath)
      : undefined;
  }

  private async loadWritableSkeleton(docPath: DocPath): Promise<DocumentSkeletonInternal> {
    const nodes = skeletonFileExistsSync(docPath, this.overlayRoot)
      ? await DocumentSkeletonInternal.loadEffectiveNodes(
          docPath,
          this.overlayRoot,
          this.canonicalRoot,
          await this.loadDeletedSectionFiles(docPath),
        )
      : await DocumentSkeletonInternal.loadNodesFromRoot(docPath, this.canonicalRoot);
    return DocumentSkeletonInternal.fromNodes(
      docPath,
      nodes,
      this.overlayRoot,
      (bodyFilePath) => this.canonicalBodyExists(bodyFilePath),
    );
  }

  private async canonicalBodyExists(proposalBodyFilePath: string): Promise<boolean> {
    if (this.overlayRoot === this.canonicalRoot) return false;
    const rel = path.relative(this.overlayRoot, proposalBodyFilePath);
    return pathExists(path.join(this.canonicalRoot, rel));
  }

  private async readSkeleton(docPath: DocPath): Promise<DocumentSkeleton> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await throwForAbsentDocument(docPath, [this.overlayRoot, this.canonicalRoot]);
    }
    const deletedSectionFiles = await this.loadDeletedSectionFiles(docPath);
    return DocumentSkeleton.fromDisk(docPath, this.overlayRoot, this.canonicalRoot, deletedSectionFiles);
  }

  async getDocumentStructure(docPath: DocPath): Promise<DocStructureNode[]> {
    const skeleton = await this.readSkeleton(docPath);
    return skeleton.structure;
  }

  async resolveSectionFileId(docPath: DocPath, sectionFileId: string): Promise<{ absolutePath: string; headingPath: string[]; headingLevel: HeadingLevel; heading: string }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireEntryBySectionFileId(sectionFileId);
      return { absolutePath: entry.absolutePath, headingPath: entry.headingPath, headingLevel: entry.headingLevel, heading: entry.heading };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  async resolveSectionPath(docPath: DocPath, headingPath: string[]): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      return skeleton.requireContentEntryByHeadingPath(headingPath).absolutePath;
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  async resolveSectionPathWithLevel(docPath: DocPath, headingPath: string[]): Promise<{ absolutePath: string; headingLevel: HeadingLevel }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireContentEntryByHeadingPath(headingPath);
      return { absolutePath: entry.absolutePath, headingLevel: entry.headingLevel };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  async listHeadingPaths(docPath: DocPath): Promise<string[][]> {
    const skeleton = await this.readSkeleton(docPath);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    return paths;
  }

  sectionsDirectory(docPath: DocPath): string {
    return DocumentSkeleton.sectionsDir(docPath, this.overlayRoot);
  }

  async tombstoneDocument(docPath: DocPath): Promise<string[][]> {
    const skeleton = await DocumentSkeleton.fromSingleRoot(docPath, this.canonicalRoot);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    await this.tombstoneDocumentExplicit(docPath);
    return paths;
  }

  async renameDocument(
    sourceDocPath: DocPath,
    destinationDocPath: DocPath,
  ): Promise<void> {
    const sourceState = await this.getDocumentState(sourceDocPath);
    if (sourceState === "tombstone") {
      throw new DocumentNotFoundError(`Cannot rename "${sourceDocPath}": pending deletion in this proposal.`);
    }
    if (sourceState === "missing") {
      throw new DocumentNotFoundError(`Cannot rename "${sourceDocPath}": document does not exist.`);
    }

    const destinationState = await this.getDocumentState(destinationDocPath);
    if (destinationState !== "missing") {
      throw new Error(
        `Cannot rename "${sourceDocPath}" → "${destinationDocPath}": destination already exists (${destinationState}). ` +
        `The new path must be absent in both the proposal and canonical before a rename.`,
      );
    }

    const sourceSkeleton = await this.readSkeleton(sourceDocPath);

    const overlaySrcSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, sourceDocPath);
    const overlayDestSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, destinationDocPath);
    const srcSectionsDir = `${overlaySrcSkeletonPath}.sections`;
    const destSectionsDir = `${overlayDestSkeletonPath}.sections`;

    const topSkeleton = await this.readEffectiveSectionBody(overlaySrcSkeletonPath);
    if (topSkeleton === null) {
      throw new DocumentAssemblyError(
        `Rename source "${sourceDocPath}" is live but its skeleton file is missing in both layers.`,
      );
    }
    await mkdir(path.dirname(overlayDestSkeletonPath), { recursive: true });
    await writeFile(overlayDestSkeletonPath, topSkeleton, "utf8");

    const declaredPaths: string[] = [];
    sourceSkeleton.forEachNode((_h, _l, _sf, _hp, absolutePath) => {
      declaredPaths.push(absolutePath);
    });
    for (const sourceAbsolutePath of declaredPaths) {
      const content = await this.readEffectiveSectionBody(sourceAbsolutePath);
      if (content === null) {
        throw new DocumentAssemblyError(
          `Rename "${sourceDocPath}" → "${destinationDocPath}": declared file ` +
          `"${path.relative(srcSectionsDir, sourceAbsolutePath)}" has no content in any layer ` +
          `(skeleton and section files are out of sync).`,
        );
      }
      const destPath = path.join(destSectionsDir, path.relative(srcSectionsDir, sourceAbsolutePath));
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, content, "utf8");
    }

    await this.tombstoneDocumentExplicit(sourceDocPath);
  }

  async getSectionList(
    docPath: DocPath,
  ): Promise<Array<{ heading: string; headingLevel: HeadingLevel; sectionFile: string; headingPath: string[] }>> {
    const skeleton = await this.readSkeleton(docPath);
    const sections: Array<{ heading: string; headingLevel: HeadingLevel; sectionFile: string; headingPath: string[] }> = [];
    skeleton.forEachVisibleSection((heading, headingLevel, sectionFile, headingPath) => {
      sections.push({ heading, headingLevel, sectionFile, headingPath: [...headingPath] });
    });
    return sections;
  }

  async readAllSections(docPath: DocPath): Promise<Map<string, SectionBody>> {
    const skeleton = await this.readSkeleton(docPath);
    const result = new Map<string, SectionBody>();
    const readTasks: Array<Promise<void>> = [];

    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, absolutePath) => {
      readTasks.push(
        (async () => {
          const key = SectionRef.headingKey(headingPath);
          const content = await this.requireEffectiveSectionBody(absolutePath, docPath, key);
          result.set(key, bodyFromDisk(content));
        })(),
      );
    });

    await Promise.all(readTasks);
    return result;
  }

  private validateUpsertHeadingArgument(ref: SectionRef, heading: string): void {
    const targetingBfh = ref.headingPath.length === 0;
    const headingProvided = heading.trim().length > 0;
    if (targetingBfh && headingProvided) {
      throw new Error(
        `Illegal arguments: targeting the headingless root section but provided a heading.`,
      );
    }
    if (!targetingBfh && !headingProvided) {
      throw new Error(
        `Illegal arguments: targeting a headed section but missing the section heading.`,
      );
    }
  }

  async upsertSection(
    ref: SectionRef,
    heading: string,
    content: SectionBodyWithPotentialSubsections,
    opts?: { expandHeadingsIntoSections?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    this.validateUpsertHeadingArgument(ref, heading);

    if (ref.headingPath.length === 0) {
      return await this.upsertSectionFromMarkdownCore(ref, content);
    }

    const parsed = getParser().parseDocumentMarkdown(content);
    const firstHeaded = parsed.find((sec) => !parsedSectionIsHeadless(sec));

    if (firstHeaded && firstHeaded.heading === heading) {
      return await this.upsertSectionFromMarkdownCore(ref, content);
    }

    if (opts?.expandHeadingsIntoSections) {
      if (firstHeaded && firstHeaded.heading !== heading) {
        throw new Error(
          `Illegal arguments: content heading "${firstHeaded.heading}" does not match explicit heading "${heading}".`,
        );
      }
      return await this.upsertSectionFromMarkdownCore(ref, content);
    }

    const headingLevel = await this.resolveTargetHeadingLevel(ref);
    const markdown = content
      ? `${"#".repeat(headingLevel)} ${heading}\n\n${content}`
      : `${"#".repeat(headingLevel)} ${heading}`;
    return await this.upsertSectionFromMarkdownCore(ref, markdown);
  }

  async writeSectionBodyVerbatim(
    ref: SectionRef,
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocument(ref.docPath);
    }

    let skeleton = await this.getWritableSkeleton(ref.docPath);
    let createdBfh = false;
    if (ref.headingPath.length === 0 && !skeleton.has([])) {
      await this.createEmptyBfhAtFront(ref.docPath);
      createdBfh = true;
      skeleton = await this.getWritableSkeleton(ref.docPath);
    }
    const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);

    const newBody = bodyFromDisk(body as unknown as string);
    const currentBody = bodyFromDisk(
      (await this.readEffectiveSectionBody(entry.absolutePath)) ?? "",
    );
    if (!createdBfh && (currentBody as string) === (newBody as string)) {
      return {
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      };
    }

    await this.writeOverlayBodyFile(ref.docPath, entry, newBody);
    return {
      writtenEntries: [flatEntryFromContentEntry(entry)],
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: [flatEntryFromContentEntry(entry)],
      structureChanges: [],
    };
  }

  private async resolveTargetHeadingLevel(ref: SectionRef): Promise<number> {
    if ((await this.getDocumentState(ref.docPath)) !== "live") {
      return ref.headingPath.length;
    }
    const skeleton = await this.readSkeleton(ref.docPath);
    const existing = skeleton.findStructuralNodeByHeadingPath(ref.headingPath);
    if (existing) return existing.headingLevel;
    for (let i = ref.headingPath.length - 1; i >= 1; i--) {
      const ancestor = skeleton.findStructuralNodeByHeadingPath(ref.headingPath.slice(0, i));
      if (ancestor) return ancestor.headingLevel + (ref.headingPath.length - i);
    }
    return ref.headingPath.length;
  }

  async upsertSectionMergingToPrevious(
    ref: SectionRef,
    bodyContent: string,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    return await this.upsertSectionFromMarkdownCore(
      ref,
      bodyContent,
      { requireMergeToPrevious: true },
    );
  }

  private async upsertSectionFromMarkdownCore(
    ref: SectionRef,
    markdown: string,
    opts?: { requireMergeToPrevious?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const targetingBfh = ref.headingPath.length === 0;
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this proposal.`);
    }
    let createdDocument = false;
    if (state === "missing") {
      await this.createDocument(ref.docPath);
      createdDocument = true;
    }
    let preWriteSkeleton = await this.getWritableSkeleton(ref.docPath);
    let skeleton = preWriteSkeleton;
    const materializedEntries: FlatEntry[] = [];
    if (targetingBfh && !skeleton.has([])) {
      materializedEntries.push(await this.createEmptyBfhAtFront(ref.docPath));
      skeleton = await this.getWritableSkeleton(ref.docPath);
    }
    if (!skeleton.has(ref.headingPath)) {
      const installSkeleton = await this.getWritableSkeleton(ref.docPath);
      let firstMissing = 0;
      while (
        firstMissing < ref.headingPath.length
        && installSkeleton.has(ref.headingPath.slice(0, firstMissing + 1))
      ) {
        firstMissing++;
      }
      const parentPath = ref.headingPath.slice(0, firstMissing);
      if (realSiblingHeadings(installSkeleton, parentPath).length > 0) {
        const parentLabel = parentPath.length === 0 ? "the document root" : `[${parentPath.join(" > ")}]`;
        throw new ProposalSectionReorderError(
          `Cannot create [${ref.headingPath.join(" > ")}] in ${ref.docPath} without a placement anchor: ` +
          `"${ref.headingPath[firstMissing]}" would join existing sibling sections under ${parentLabel}.`,
        );
      }

      const chain: ParsedMarkdownRewriteSection[] = [];
      for (let i = firstMissing + 1; i <= ref.headingPath.length; i++) {
        const segmentPath = ref.headingPath.slice(0, i);
        chain.push({
          headingPath: segmentPath.slice(firstMissing),
          heading: segmentPath[segmentPath.length - 1],
          headingLevel: HeadingLevel.parse(await this.resolveTargetHeadingLevel(new SectionRef(ref.docPath, segmentPath))),
          body: "",
        });
      }

      const parentIsLeaf =
        parentPath.length > 0
        && installSkeleton.subtreeEntries(parentPath).length === 1;
      const parentBody = parentIsLeaf
        ? (await this.readEffectiveSectionBody(
            installSkeleton.requireContentEntryByHeadingPath(parentPath).absolutePath,
          )) ?? ""
        : null;

      const plan = await installSkeleton.applyStructuralMutationTransaction((ctx) => {
        const siblings = ctx.findSiblingList(parentPath);
        assertNoDuplicateSiblingHeadingCollision(siblings, {
          operation: "insert",
          docPath: ref.docPath,
          parentHeadingPath: parentPath,
          targetSectionFile: "",
          proposedHeading: chain[0].heading,
          proposedHeadingLevel: chain[0].headingLevel,
        });
        const { added, bodyWrites } = planSiblingInstall(
          ctx,
          ref.docPath,
          { kind: "only-child", parentPath },
          chain,
        );

        if (parentBody !== null) {
          const parentNode = ctx.locateStructuralNodeByHeadingPath(parentPath)?.node;
          if (!parentNode) {
            throw new Error(
              `Skeleton integrity error in ${ref.docPath}: leaf parent ` +
              `[${parentPath.join(" > ")}] vanished during upsertSectionFromMarkdownCore`,
            );
          }
          ctx.addBodyHoldersToParents([parentNode]);
          const bodyHolder = parentNode.children.find((c) => isBodyHolderShape(c));
          if (!bodyHolder) {
            throw new Error(
              `Skeleton integrity error in ${ref.docPath}: addBodyHoldersToParents did not ` +
              `add a body holder for [${parentPath.join(" > ")}]`,
            );
          }
          const [bodyHolderEntry] = ctx.flattenNode(bodyHolder, parentPath, ctx.resolveSkeletonPathFor(parentPath));
          added.push(bodyHolderEntry);
          bodyWrites.push({ absolutePath: bodyHolderEntry.absolutePath, content: parentBody });
        }
        return { removed: [], added, bodyWrites, fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
      });
      for (const write of plan.bodyWrites) {
        await this.writeOverlayBodyFile(
          ref.docPath,
          { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
          write.content,
        );
      }
      materializedEntries.push(...plan.added);
      skeleton = await this.getWritableSkeleton(ref.docPath);
      preWriteSkeleton = skeleton;
    }
    const withImplicitStructuralCreates = (
      result: UpsertSectionFromMarkdownDetailedResult,
    ): UpsertSectionFromMarkdownDetailedResult => {
      const writtenEntries = [...result.writtenEntries];
      const alreadyAccountedFor = new Set([
        ...writtenEntries.map((e) => e.absolutePath),
        ...result.removedContentEntries.map((e) => e.absolutePath),
      ]);
      for (const entry of materializedEntries) {
        if (entry.isSubSkeleton) continue;
        if (alreadyAccountedFor.has(entry.absolutePath)) continue;
        alreadyAccountedFor.add(entry.absolutePath);
        writtenEntries.push(entry);
      }
      return { ...result, writtenEntries, createdDocument };
    };

    const parsedSections = getParser().parseDocumentMarkdown(markdown);

    const hasLeadingHeadless = parsedSections.length > 0
      && parsedSections[0].headingLevel === 0
      && parsedSections[0].heading === "";
    const mergeOrphanIntoPredecessor = hasLeadingHeadless && !targetingBfh;
    const leadingOrphanBody = (mergeOrphanIntoPredecessor
      ? (parsedSections[0].body as unknown as string)
      : "") as SectionBody;
    // Empty-BFH lifecycle: a BFH survivor is only worth keeping when it carries
    // non-whitespace preamble. When real headings accompany an empty/whitespace
    // preamble (a root-split or an equivalent explicit `[]` write), the BFH
    // dissolves — it is simply omitted from `headedSections`, so the shared
    // subtree-replace path below removes it and puts the promoted headings in
    // its place. A `[]` write that introduces NO real headings (a plain body
    // edit) never dissolves the BFH this way, even when the new body is empty.
    const realSectionCount = hasLeadingHeadless ? parsedSections.length - 1 : parsedSections.length;
    const bfhPreambleHasContent = targetingBfh && hasLeadingHeadless
      && (parsedSections[0].body as unknown as string).trim().length > 0;
    const dissolveEmptyBfhSurvivor = targetingBfh && !bfhPreambleHasContent && realSectionCount > 0;
    const headedSections = targetingBfh
      ? (dissolveEmptyBfhSurvivor
          ? (hasLeadingHeadless ? parsedSections.slice(1) : parsedSections)
          : (hasLeadingHeadless ? parsedSections : [
              {
                headingPath: [],
                heading: "",
                headingLevel: HeadingLevel.beforeFirstHeading,
                body: "" as unknown as SectionBody,
                fullContent: "" as unknown as FragmentContent,
              },
              ...parsedSections,
            ]))
      : (hasLeadingHeadless ? parsedSections.slice(1) : parsedSections);

    if (opts?.requireMergeToPrevious && headedSections.length > 0) {
      throw new Error(
        `Illegal arguments: upsertSectionMergingToPrevious cannot target a headed section with headed markdown content.`,
      );
    }

    if (headedSections.length === 0) {
      const deletedEntry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      const effect = await this.removeHeading(ref.docPath, ref.headingPath, leadingOrphanBody);
      return withImplicitStructuralCreates(upsertResultFromHeadingRemoval(effect, deletedEntry));
    }

    const targetIsSubSkeletonParent =
      skeleton.subtreeEntries(ref.headingPath).length > 1;
    if (headedSections.length === 1 && targetIsSubSkeletonParent) {
      const single = headedSections[0];
      const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.headingLevel === entry.headingLevel) {
        await this.writeOverlayBodyFile(
          ref.docPath,
          entry,
          single.body as unknown as string,
        );
        return withImplicitStructuralCreates({
          writtenEntries: [flatEntryFromContentEntry(entry)],
          removedContentEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries: [flatEntryFromContentEntry(entry)],
          structureChanges: [],
        });
      }
      const { oldEntry, newEntry } = await this.retitleSubSkeletonParentInPlace(
        skeleton,
        ref.docPath,
        ref.headingPath,
        single.heading,
        single.headingLevel,
      );
      await this.writeOverlayBodyFile(
        ref.docPath,
        newEntry,
        single.body as unknown as string,
      );
      return withImplicitStructuralCreates({
        writtenEntries: [flatEntryFromContentEntry(newEntry)],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [flatEntryFromContentEntry(newEntry)],
        structureChanges: [{
          oldEntry: flatEntryFromContentEntry(oldEntry),
          newEntries: [flatEntryFromContentEntry(newEntry)],
        }],
      });
    }

    if (
      !mergeOrphanIntoPredecessor
      && (await this.isIdentityUpsert(preWriteSkeleton, ref.headingPath, headedSections))
    ) {
      return withImplicitStructuralCreates({
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      });
    }

    if (targetIsSubSkeletonParent && headedSections.length > 1) {
      return withImplicitStructuralCreates(
        await this.applyMultiHeadingPayloadToSubSkeletonParent(
          ref,
          headedSections,
          leadingOrphanBody,
        ),
      );
    }

    if (headedSections.length === 1 && !targetIsSubSkeletonParent) {
      const single = headedSections[0];
      const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.headingLevel === entry.headingLevel) {
        const writtenEntries: FlatEntry[] = [flatEntryFromContentEntry(entry)];
        const liveReloadEntries: FlatEntry[] = [flatEntryFromContentEntry(entry)];

        if (mergeOrphanIntoPredecessor) {
          const prevHolder = skeleton.findPreviousBodyHolder(entry.sectionFile);
          if (prevHolder) {
            const existing = bodyFromDisk(
              await this.requireEffectiveSectionBody(prevHolder.absolutePath, ref.docPath, prevHolder.sectionFile),
            );
            const merged = appendToBody(existing, leadingOrphanBody);
            await this.writeOverlayBodyFile(
              ref.docPath,
              prevHolder,
              merged as unknown as string,
            );
            writtenEntries.push(prevHolder);
            liveReloadEntries.push(prevHolder);
          } else {
            return withImplicitStructuralCreates(
              await this.replaceSubtreeDeletingOmittedSections(
                ref.docPath,
                ref.headingPath,
                headedSections,
                { leadingOrphanBody },
              ),
            );
          }
        }

        await this.writeOverlayBodyFile(
          ref.docPath,
          entry,
          single.body as unknown as string,
        );

        return withImplicitStructuralCreates({
          writtenEntries,
          removedContentEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries,
          structureChanges: [],
        });
      }
    }

    return withImplicitStructuralCreates(
      await this.replaceSubtreeDeletingOmittedSections(
        ref.docPath,
        ref.headingPath,
        headedSections,
        { leadingOrphanBody },
      ),
    );
  }

  private async applyMultiHeadingPayloadToSubSkeletonParent(
    ref: SectionRef,
    headedSections: ReadonlyArray<ParsedSection>,
    leadingOrphanBody: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const aggregate: UpsertSectionFromMarkdownDetailedResult = {
      writtenEntries: [],
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: [],
      structureChanges: [],
    };
    const mergeInto = (result: UpsertSectionFromMarkdownDetailedResult): void => {
      aggregate.writtenEntries.push(...result.writtenEntries);
      aggregate.removedContentEntries.push(...result.removedContentEntries);
      aggregate.fragmentKeyRemaps.push(...result.fragmentKeyRemaps);
      aggregate.liveReloadEntries.push(...result.liveReloadEntries);
      aggregate.structureChanges.push(...result.structureChanges);
    };

    const parentPrefix = ref.headingPath.slice(0, -1);

    const skeletonBeforePlacement = await this.getWritableSkeleton(ref.docPath);
    const plannedChildMoves = planPayloadChildMoves(ref, headedSections, skeletonBeforePlacement);

    if ((leadingOrphanBody as string).length > 0) {
      const skeleton = await this.getWritableSkeleton(ref.docPath);
      const parentEntry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      const prevHolder = skeleton.findPreviousBodyHolder(parentEntry.sectionFile);
      if (!prevHolder) {
        throw new Error(
          `upsertSection in ${ref.docPath}: multi-heading payload for sub-skeleton ` +
          `parent [${ref.headingPath.join(" > ")}] carries content above the parent ` +
          `heading, and no preceding section exists to absorb it.`,
        );
      }
      const existing = bodyFromDisk(
        await this.requireEffectiveSectionBody(prevHolder.absolutePath, ref.docPath, prevHolder.sectionFile),
      );
      await this.writeOverlayBodyFile(
        ref.docPath,
        prevHolder,
        appendToBody(existing, leadingOrphanBody) as unknown as string,
      );
      aggregate.writtenEntries.push(prevHolder);
      aggregate.liveReloadEntries.push(prevHolder);
    }

    const lastDispatchedLeafByParent = new Map<string, string>();

    mergeInto(await this.upsertSectionFromMarkdownCore(
      ref,
      singleSectionMarkdown(headedSections[0]),
    ));
    lastDispatchedLeafByParent.set(headingPathKey(parentPrefix), headedSections[0].heading);

    for (const parsed of headedSections.slice(1)) {
      const resultingPath = [...parentPrefix, ...parsed.headingPath];
      const parentPath = resultingPath.slice(0, -1);
      const skeleton = await this.getWritableSkeleton(ref.docPath);
      const parentIsSubSkeletonParent = parentPath.length > 0
        && skeleton.has(parentPath)
        && skeleton.subtreeEntries(parentPath).length > 1;
      const prevLeaf = lastDispatchedLeafByParent.get(headingPathKey(parentPath)) ?? null;
      if (skeleton.has(resultingPath)) {
        mergeInto(await this.upsertSectionFromMarkdownCore(
          new SectionRef(ref.docPath, resultingPath),
          singleSectionMarkdown(parsed),
        ));
      } else if (parentIsSubSkeletonParent) {
        const placement: { kind: "before" | "after"; anchorHeadingPath: string[] } = prevLeaf !== null
          ? { kind: "after", anchorHeadingPath: [...parentPath, prevLeaf] }
          : {
              kind: "before",
              anchorHeadingPath: skeleton.subtreeEntries(parentPath)
                .filter((e) => e.headingPath.length === parentPath.length + 1)[0].headingPath,
            };
        mergeInto(await this.insertNewChildSectionBeside(
          ref.docPath,
          placement,
          parsed.heading,
          parsed.headingLevel,
          parsed.body as unknown as SectionBody,
        ));
      } else if (parentPath.length === 0 && prevLeaf !== null) {
        mergeInto(await this.upsertSectionBeside(
          ref.docPath,
          resultingPath,
          parsed.heading,
          sectionWriteInputFromExternal(singleSectionMarkdown(parsed)),
          [prevLeaf],
          "after",
        ));
      } else {
        mergeInto(await this.upsertSectionAtOnlySiblingSlot(
          ref.docPath,
          resultingPath,
          parsed.heading,
          sectionWriteInputFromExternal(singleSectionMarkdown(parsed)),
        ));
      }
      lastDispatchedLeafByParent.set(headingPathKey(parentPath), parsed.heading);
    }

    for (const { childSectionFile, newParentPath } of plannedChildMoves) {
      const skeleton = await this.getWritableSkeleton(ref.docPath);
      const child = skeleton.requireEntryBySectionFileId(childSectionFile);
      const destChildren = realDirectChildEntries(skeleton, newParentPath);
      const destination: SectionInsertPlacement = destChildren.length === 0
        ? { kind: "only-child", parentPath: newParentPath }
        : { kind: "after", anchorHeadingPath: destChildren[destChildren.length - 1]!.headingPath };
      const { added } = await this.moveSubtree(
        ref.docPath,
        child.headingPath,
        destination,
        child.headingLevel,
      );
      for (const entry of added) {
        if (entry.isSubSkeleton) continue;
        aggregate.writtenEntries.push(entry);
        aggregate.liveReloadEntries.push(entry);
      }
    }

    return aggregate;
  }

  private async isIdentityUpsert(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
    parsedSections: ReadonlyArray<ParsedSection>,
  ): Promise<boolean> {
    if (parsedSections.length === 0) return false;
    if (!skeleton.has(headingPath)) return false;

    const liveEntries = skeleton.subtreeEntries(headingPath);
    if (liveEntries.length !== parsedSections.length) return false;

    const parentPrefix = headingPath.slice(0, -1);
    for (const parsed of parsedSections) {
      const absoluteHeadingPath = [...parentPrefix, ...parsed.headingPath];
      const liveEntry = skeleton.findContentEntryByHeadingPath(absoluteHeadingPath);
      if (!liveEntry) return false;
      if (liveEntry.heading !== parsed.heading) return false;
      if (liveEntry.headingLevel !== parsed.headingLevel) return false;
      const liveBody = bodyFromDisk(
        (await this.readEffectiveSectionBody(liveEntry.absolutePath)) ?? "",
      );
      if ((liveBody as string) !== (parsed.body as unknown as string)) return false;
    }
    return true;
  }

  async createDocumentFromMarkdown(docPath: DocPath, markdown: string): Promise<void> {
    await this.createDocument(docPath);
    const parsedSections = getParser().parseDocumentMarkdown(markdown);
    await this.writeFreshDocumentFromParsedMarkdown(docPath, parsedSections);
  }

  async replaceDocumentFromMarkdown(docPath: DocPath, markdown: string): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state !== "live") {
      throw new DocumentNotFoundError(
        state === "tombstone"
          ? `Document "${docPath}" is pending deletion in this proposal.`
          : `Document "${docPath}" does not exist.`,
      );
    }
    const parsedSections = getParser().parseDocumentMarkdown(markdown);
    await this.replaceWholeDocumentFromParsedMarkdown(docPath, parsedSections);
  }

  private async replaceWholeDocumentFromParsedMarkdown(
    docPath: DocPath,
    parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  ): Promise<void> {
    const skeleton = await this.getWritableSkeleton(docPath);

    const { replacementRoots, bodyByResultingHeadingPath } = buildReplacementRoots(
      [],
      parsedSections,
    );

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const roots = ctx.findSiblingList([]);
      const parentSkeletonPath = ctx.resolveSkeletonPathFor([]);

      const removed: FlatEntry[] = [];
      for (const node of roots) {
        removed.push(...ctx.flattenNode(node, [], parentSkeletonPath));
      }

      ctx.addBodyHoldersToParents(replacementRoots);
      roots.splice(0, roots.length, ...replacementRoots);

      const added: FlatEntry[] = [];
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, [], parentSkeletonPath));
      }

      const bodyWrites = buildBodyWritesForReplacement(docPath, added, bodyByResultingHeadingPath);

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
  }

  async upsertDocumentFromMarkdown(
    docPath: DocPath,
    markdown: string,
  ): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocumentFromMarkdown(docPath, markdown);
    } else {
      await this.replaceDocumentFromMarkdown(docPath, markdown);
    }
  }

  async readSection(ref: SectionRef): Promise<SectionBody> {
    const skeleton = await this.readSkeleton(ref.docPath);
    let entry: ContentEntry;
    try {
      entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
    const content = await this.readEffectiveSectionBody(entry.absolutePath);
    if (content === null) {
      throw new SectionNotFoundError(`Section not found in any layer for "${ref.docPath}" [${ref.headingPath.join(" > ")}]`);
    }
    return bodyFromDisk(content);
  }

  private readEffectiveSectionBody(proposalBodyPath: string): string | null {
    const overlayContent = readFileIfExistsSync(proposalBodyPath);
    if (overlayContent !== null) return overlayContent;
    const canonicalPath = path.join(
      this.canonicalRoot,
      path.relative(this.overlayRoot, proposalBodyPath),
    );
    return readFileIfExistsSync(canonicalPath);
  }

  private async requireEffectiveSectionBody(
    proposalBodyPath: string,
    docPath: DocPath,
    sectionLabel: string,
  ): Promise<string> {
    const content = await this.readEffectiveSectionBody(proposalBodyPath);
    if (content === null) {
      throw new DocumentAssemblyError(
        `Section "${sectionLabel}" in document "${docPath}" is referenced by the skeleton but has no body file in any layer. ` +
        `This indicates data corruption — the skeleton and section files are out of sync.`,
      );
    }
    return content;
  }

  private async ensureProposalSkeletonForWrite(docPath: DocPath): Promise<void> {
    if (this.overlayRoot === this.canonicalRoot) return;
    if (await skeletonFileExists(docPath, this.overlayRoot)) return;

    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
  }

  private async writeOverlayBodyFile(
    docPath: DocPath,
    entry: ContentEntry | FlatEntry,
    content: string,
  ): Promise<void> {
    await this.ensureProposalSkeletonForWrite(docPath);
    await writeBodyFile(entry, content);
  }

  async saveLeadingChunk(
    docPath: DocPath,
    headingPath: string[],
    chunk: SectionBody,
  ): Promise<HeadingRemovalMergeTarget> {
    const trimmedChunk = stripLeadingNewlines(chunk);
    if ((trimmedChunk as string).trim().length === 0) {
      throw new Error(
        `saveLeadingChunk called for [${headingPath.join(" > ")}] in ${docPath} with a whitespace-only chunk.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const entry = skeleton.requireContentEntryByHeadingPath(headingPath);
    const predecessor = skeleton.findPreviousBodyHolder(entry.sectionFile);

    if (predecessor) {
      const existing = bodyFromDisk(
        await this.requireEffectiveSectionBody(predecessor.absolutePath, docPath, predecessor.sectionFile),
      );
      const merged = appendToBody(existing, trimmedChunk);
      await this.writeOverlayBodyFile(docPath, predecessor, merged as string);
      let visibleHeading = predecessor.heading;
      let visibleHeadingLevel = predecessor.headingLevel;
      if (predecessor.headingPath.length === 0) {
        visibleHeading = "";
        visibleHeadingLevel = HeadingLevel.beforeFirstHeading;
      } else if (predecessor.heading === "") {
        const owner = skeleton.requireStructuralNodeByHeadingPath(predecessor.headingPath);
        visibleHeading = owner.heading;
        visibleHeadingLevel = owner.headingLevel;
      }
      return {
        oldEntry: predecessor,
        newEntry: predecessor,
        visibleHeadingPath: [...predecessor.headingPath],
        visibleHeading,
        visibleHeadingLevel,
        wasCreated: false,
        mergedBody: merged as string,
      };
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const bfhEntry = ctx.createBfhAtFront();
      return {
        removed: [],
        added: [bfhEntry],
        bodyWrites: [{ absolutePath: bfhEntry.absolutePath, content: trimmedChunk as string }],
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    const [bfh] = plan.added;
    return {
      oldEntry: null,
      newEntry: bfh,
      visibleHeadingPath: [],
      visibleHeading: "",
      visibleHeadingLevel: HeadingLevel.beforeFirstHeading,
      wasCreated: true,
      mergedBody: trimmedChunk as string,
    };
  }

  /**
   * Remove ONE heading — the single heading-removal method (predecessor merge,
   * document-start anchoring, and id-preserving descendant reparenting in one
   * engine, structural decisions owned by `DocumentSkeletonInternal.removeHeading`).
   *
   * `orphanBody` is the AUTHORITATIVE body the removed heading leaves behind
   * (the live fragment's orphan on the quiescence path; the written markdown's
   * leading orphan on the section-write path). The target's previously stored
   * body is discarded — it was replaced by whatever produced the orphan. The
   * orphan merges into the effect's declared merge target exactly once; preserved
   * descendant body files are relocated by section-file id.
   */
  async removeHeading(
    docPath: DocPath,
    headingPath: string[],
    orphanBody: SectionBody,
  ): Promise<HeadingRemovalEffect> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const trimmedOrphan = stripLeadingNewlines(orphanBody);
    const orphanHasContent = (trimmedOrphan as string).trim().length > 0;

    const effect = await skeleton.removeHeading(headingPath, {
      createDocumentStartAnchor: orphanHasContent,
    });

    // Read every effective body the removal relocates BEFORE deleting anything —
    // the old files (overlay-else-canonical) are the only source.
    let mergeTargetPreBody: string | null = null;
    if (effect.mergeTarget && effect.mergeTarget.oldEntry) {
      mergeTargetPreBody = await this.readEffectiveSectionBody(effect.mergeTarget.oldEntry.absolutePath);
    }
    const relocatedBodiesById = new Map<string, string>();
    for (const { oldEntry, newEntry } of effect.preservedDescendants) {
      if (oldEntry.absolutePath === newEntry.absolutePath) continue;
      const body = await this.readEffectiveSectionBody(oldEntry.absolutePath);
      if (body !== null) relocatedBodiesById.set(newEntry.sectionFile, body);
    }

    // Delete the removed heading's own files. Its `.sections` tree holds the
    // preserved descendants' OLD files (already read above), so the recursive
    // removal is also their old-location cleanup.
    for (const removed of effect.removedTargetEntries) {
      if (removed.isSubSkeleton) {
        await rm(`${removed.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(removed.absolutePath, { force: true });
    }
    // A merge target that transitioned leaf → parent keeps its section-file id at
    // a new body-holder path; its old-location file must not linger.
    if (
      effect.mergeTarget?.oldEntry &&
      effect.mergeTarget.oldEntry.absolutePath !== effect.mergeTarget.newEntry.absolutePath
    ) {
      await rm(effect.mergeTarget.oldEntry.absolutePath, { force: true });
    }

    for (const write of effect.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }

    for (const { newEntry } of effect.preservedDescendants) {
      const body = relocatedBodiesById.get(newEntry.sectionFile);
      if (body === undefined) continue;
      await this.writeOverlayBodyFile(docPath, newEntry, body);
    }

    if (effect.mergeTarget) {
      const mergeTarget = effect.mergeTarget;
      const relocated =
        mergeTarget.oldEntry !== null &&
        mergeTarget.oldEntry.absolutePath !== mergeTarget.newEntry.absolutePath;
      if (mergeTarget.wasCreated) {
        await this.writeOverlayBodyFile(docPath, mergeTarget.newEntry, trimmedOrphan as string);
        mergeTarget.mergedBody = trimmedOrphan as string;
      } else if (orphanHasContent || relocated) {
        const preBody = bodyFromDisk(mergeTargetPreBody ?? "");
        const merged = orphanHasContent ? appendToBody(preBody, trimmedOrphan) : preBody;
        await this.writeOverlayBodyFile(docPath, mergeTarget.newEntry, merged as string);
        mergeTarget.mergedBody = merged as string;
      }
    }

    // Empty-BFH lifecycle: a heading deletion that settles into the BFH (the
    // merge target IS the before-first-heading section, never freshly created —
    // a created anchor always carries the non-empty orphan by construction) does
    // not leave a merely-empty BFH behind. When the merge target's final body is
    // empty/whitespace, dissolve it: splice it out of the skeleton in a second
    // structural mutation and report it separately from `mergeTarget` (now null)
    // so the manifest never claims it and the live side can unregister its key.
    if (
      effect.mergeTarget
      && !effect.mergeTarget.wasCreated
      && effect.mergeTarget.visibleHeadingPath.length === 0
      && (effect.mergeTarget.mergedBody ?? mergeTargetPreBody ?? "").trim() === ""
    ) {
      const bfhEntry = effect.mergeTarget.newEntry;
      const dissolvePlan = await skeleton.applyStructuralMutationTransaction((ctx) => {
        const located = ctx.locateStructuralNodeByHeadingPath([]);
        if (!located || located.node.sectionFile !== bfhEntry.sectionFile) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: BFH section file "${bfhEntry.sectionFile}" ` +
            `not found at document root during empty-BFH dissolve.`,
          );
        }
        const { siblings: roots, index: idx } = located;
        const removed = ctx.flattenNode(located.node, [], located.parentSkeletonPath);
        roots.splice(idx, 1);
        return {
          removed,
          added: [],
          bodyWrites: [],
          fragmentKeyRemaps: removed.map((e) => ({ from: e.sectionFile, to: null })),
        } satisfies StructuralMutationPlan;
      });
      await rm(bfhEntry.absolutePath, { force: true });
      const dissolvedIds = dissolvePlan.removed.filter((e) => !e.isSubSkeleton).map((e) => e.sectionFile);
      return {
        ...effect,
        dissolvedBfh: bfhEntry,
        deletedSectionFileIds: [...effect.deletedSectionFileIds, ...dissolvedIds],
        fragmentKeyChanges: [...effect.fragmentKeyChanges, ...dissolvePlan.fragmentKeyRemaps],
      };
    }

    return effect;
  }


  async deleteSubtree(docPath: DocPath, headingPath: string[]): Promise<FlatEntry[]> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located) {
        throw staleHeadingPath(
          docPath,
          headingPath,
          headingPath.length === 0 ? "no before-first-heading section to delete" : "cannot delete subtree",
        );
      }
      const { siblings, index: idx, node, parentPath, parentSkeletonPath } = located;
      const removed = ctx.flattenNode(node, parentPath, parentSkeletonPath);
      siblings.splice(idx, 1);
      return {
        removed,
        added: [],
        bodyWrites: [],
        fragmentKeyRemaps: removed.map((e) => ({ from: e.sectionFile, to: null })),
      } satisfies StructuralMutationPlan;
    });
    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    return plan.removed;
  }

  async renameHeading(
    docPath: DocPath,
    headingPath: string[],
    newHeading: string,
  ): Promise<ContentEntry> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot rename the before-first-heading section in ${docPath} — it has no heading.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const oldEntry = skeleton.requireContentEntryByHeadingPath(headingPath);
    const targetIsSubSkeletonParent = skeleton.subtreeEntries(headingPath).length > 1;

    if (targetIsSubSkeletonParent) {
      const { newEntry } = await this.retitleSubSkeletonParentInPlace(
        skeleton,
        docPath,
        headingPath,
        newHeading,
        oldEntry.headingLevel,
      );
      return newEntry;
    }

    const oldBody = (await this.readEffectiveSectionBody(oldEntry.absolutePath)) ?? "";

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located) {
        throw staleHeadingPath(docPath, headingPath, "cannot rename");
      }
      const { siblings, index: idx, node: oldNode, parentPath, parentSkeletonPath } = located;

      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: oldNode.sectionFile,
        proposedHeading: newHeading,
        proposedHeadingLevel: oldNode.headingLevel,
      });
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);

      const newSectionFile = oldNode.sectionFile;
      const newNode: SkeletonNode = {
        heading: newHeading,
        headingLevel: oldNode.headingLevel,
        sectionFile: newSectionFile,
        children: oldNode.children,
      };
      siblings.splice(idx, 1, newNode);
      const added = ctx.flattenNode(newNode, parentPath, parentSkeletonPath);

      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      const newTopEntry = added.find((e) => !e.isSubSkeleton && e.headingPath.length === parentPath.length + 1);
      if (newTopEntry) {
        bodyWrites.push({ absolutePath: newTopEntry.absolutePath, content: oldBody });
      }

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    return skeleton.requireContentEntryByHeadingPath([...headingPath.slice(0, -1), newHeading]);
  }

  private async retitleSubSkeletonParentInPlace(
    skeleton: DocumentSkeletonInternal,
    docPath: DocPath,
    headingPath: string[],
    newHeading: string,
    newHeadingLevel: HeadingLevel,
  ): Promise<{ oldEntry: ContentEntry; newEntry: ContentEntry }> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot retitle the before-first-heading section in ${docPath} — it has no heading.`,
      );
    }

    const oldEntry = skeleton.requireContentEntryByHeadingPath(headingPath);
    const parentPath = headingPath.slice(0, -1);
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located) {
        throw staleHeadingPath(docPath, headingPath, "cannot retitle sub-skeleton parent");
      }
      const { siblings, index: idx } = located;
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: siblings[idx].sectionFile,
        proposedHeading: newHeading,
        proposedHeadingLevel: newHeadingLevel,
      });
      siblings[idx].heading = newHeading;
      siblings[idx].headingLevel = newHeadingLevel;
      return {
        removed: [],
        added: [],
        bodyWrites: [],
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    const newHeadingPath = [...parentPath, newHeading];
    const newEntry = skeleton.requireContentEntryByHeadingPath(newHeadingPath);
    return { oldEntry, newEntry };
  }

  async retitleSectionInPlace(
    docPath: DocPath,
    headingPath: string[],
    newHeading: string,
    newHeadingLevel: HeadingLevel,
    body: SectionBody,
  ): Promise<ContentEntry> {
    if (headingPath.length === 0) {
      throw new Error(`Cannot retitle the before-first-heading section in ${docPath} — it has no heading.`);
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    skeleton.requireContentEntryByHeadingPath(headingPath);
    const parentPath = headingPath.slice(0, -1);
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located) throw staleHeadingPath(docPath, headingPath, "cannot retitle");
      const { siblings, index: idx } = located;
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: siblings[idx].sectionFile,
        proposedHeading: newHeading,
        proposedHeadingLevel: newHeadingLevel,
      });
      siblings[idx].heading = newHeading;
      siblings[idx].headingLevel = newHeadingLevel;
      return { removed: [], added: [], bodyWrites: [], fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
    const newHeadingPath = [...parentPath, newHeading];
    const newEntry = skeleton.requireContentEntryByHeadingPath(newHeadingPath);
    await this.writeOverlayBodyFile(
      docPath,
      { absolutePath: newEntry.absolutePath, isSubSkeleton: false } as FlatEntry,
      body as string,
    );
    return newEntry;
  }

  async moveSubtree(
    docPath: DocPath,
    headingPath: string[],
    destination: SectionInsertPlacement,
    newHeadingLevel: HeadingLevel,
  ): Promise<{ removed: FlatEntry[]; added: FlatEntry[] }> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot move the before-first-heading section in ${docPath}.`,
      );
    }
    const newParentPath = placementParentPath(destination);
    const skeleton = await this.getWritableSkeleton(docPath);

    const preEntries = skeleton.subtreeEntries(headingPath);
    const preBodies = new Map<string, string>();
    for (const entry of preEntries) {
      if (entry.isSubSkeleton) continue;
      const relKey = entry.headingPath.slice(headingPath.length - 1).join("\u0000");
      preBodies.set(relKey, (await this.readEffectiveSectionBody(entry.absolutePath)) ?? "");
    }

    const destParentIsLeaf =
      newParentPath.length > 0
      && skeleton.has(newParentPath)
      && skeleton.subtreeEntries(newParentPath).length === 1;
    const destParentBody = destParentIsLeaf
      ? (await this.readEffectiveSectionBody(
          skeleton.requireContentEntryByHeadingPath(newParentPath).absolutePath,
        )) ?? ""
      : null;

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located) {
        throw staleHeadingPath(docPath, headingPath, "cannot move (source)");
      }
      const { siblings: sourceSiblings, index: sourceIdx, node: movedNode, parentPath, parentSkeletonPath } = located;

      const destSiblingsCheck = ctx.findSiblingList(newParentPath);
      assertNoDuplicateSiblingHeadingCollision(destSiblingsCheck, {
        operation: "move",
        docPath,
        parentHeadingPath: newParentPath,
        targetSectionFile: movedNode.sectionFile,
        proposedHeading: movedNode.heading,
        proposedHeadingLevel: newHeadingLevel,
      });

      const removed = ctx.flattenNode(movedNode, parentPath, parentSkeletonPath);
      sourceSiblings.splice(sourceIdx, 1);

      const relabeled: SkeletonNode = {
        heading: movedNode.heading,
        headingLevel: newHeadingLevel,
        sectionFile: movedNode.sectionFile,
        children: movedNode.children,
      };

      ctx.placeSectionNodes(destination, [relabeled]);

      const destSkeletonPath = ctx.resolveSkeletonPathFor(newParentPath);
      let migratedDestParentBodyPath: string | null = null;
      if (newParentPath.length > 0) {
        const parentNode = ctx.locateStructuralNodeByHeadingPath(newParentPath)?.node;
        if (parentNode) {
          ctx.addBodyHoldersToParents([parentNode]);
          if (destParentBody !== null) {
            const bodyHolder = parentNode.children.find((c) => isBodyHolderShape(c));
            if (!bodyHolder) {
              throw new Error(
                `Skeleton integrity error in ${docPath}: addBodyHoldersToParents did not ` +
                `add a body holder for the move destination [${newParentPath.join(" > ")}]`,
              );
            }
            migratedDestParentBodyPath = path.join(
              `${destSkeletonPath}.sections`,
              bodyHolder.sectionFile,
            );
          }
        }
      }
      const added = ctx.flattenNode(relabeled, newParentPath, destSkeletonPath);

      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      if (migratedDestParentBodyPath !== null) {
        bodyWrites.push({ absolutePath: migratedDestParentBodyPath, content: destParentBody! });
      }
      for (const addedEntry of added) {
        if (addedEntry.isSubSkeleton) continue;
        const rel = addedEntry.headingPath.slice(newParentPath.length).join("\u0000");
        const body = preBodies.get(rel);
        if (body !== undefined) {
          bodyWrites.push({ absolutePath: addedEntry.absolutePath, content: body });
        }
      }

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    return { removed: plan.removed, added: plan.added };
  }

  async reorderSiblingSection(
    docPath: DocPath,
    headingPath: string[],
    targetHeadingPath: string[],
    position: "before" | "after",
  ): Promise<void> {
    if (headingPath.length === 0) {
      throw new Error(`Cannot reorder the before-first-heading section in ${docPath}.`);
    }
    if (targetHeadingPath.length === 0) {
      throw new Error(`Cannot reorder relative to the before-first-heading section in ${docPath}.`);
    }
    const parentPath = headingPath.slice(0, -1);
    const targetParentPath = targetHeadingPath.slice(0, -1);
    if (parentPath.length !== targetParentPath.length || !parentPath.every((p, i) => p === targetParentPath[i])) {
      throw new Error(
        `reorderSiblingSection in ${docPath}: source [${headingPath.join(" > ")}] and target ` +
        `[${targetHeadingPath.join(" > ")}] are not siblings (different parent). ` +
        `Use moveSubtree for reparenting.`,
      );
    }

    const skeleton = await this.getWritableSkeleton(docPath);
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located) {
        throw staleHeadingPath(docPath, headingPath, "cannot reorder (source)");
      }
      const { siblings, index: sourceIdx } = located;
      const targetLeaf = targetHeadingPath[targetHeadingPath.length - 1];
      const targetIdx = siblings.findIndex((n) => headingsEqual(n.heading, targetLeaf));
      if (targetIdx < 0) {
        throw staleHeadingPath(docPath, targetHeadingPath, "cannot reorder (target)");
      }
      if (sourceIdx === targetIdx) {
        return { removed: [], added: [], bodyWrites: [], fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
      }

      const [movedNode] = siblings.splice(sourceIdx, 1);
      const newTargetIdx = siblings.findIndex((n) => headingsEqual(n.heading, targetLeaf));
      const insertAt = position === "before" ? newTargetIdx : newTargetIdx + 1;
      siblings.splice(insertAt, 0, movedNode);

      return { removed: [], added: [], bodyWrites: [], fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
  }

  /**
   * Place a parsed forest immediately before `anchorHeadingPath`, as siblings
   * of the anchor, in one structural transaction. `sections` are addressed
   * relative to the anchor's parent; each carries its own heading level and
   * body. A top-level heading that is already a sibling is a duplicate and
   * rejects before anything is written.
   */
  async insertSiblingForestBefore(
    docPath: DocPath,
    anchorHeadingPath: string[],
    sections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const parentPath = anchorHeadingPath.slice(0, -1);
    const skeleton = await this.getWritableSkeleton(docPath);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      for (const section of sections) {
        if (section.headingPath.length !== 1) continue;
        assertNoDuplicateSiblingHeadingCollision(siblings, {
          operation: "insert",
          docPath,
          parentHeadingPath: parentPath,
          targetSectionFile: "",
          proposedHeading: section.heading,
          proposedHeadingLevel: section.headingLevel,
        });
      }
      const { added, bodyWrites } = planSiblingInstall(
        ctx,
        docPath,
        { kind: "before", anchorHeadingPath },
        sections,
      );
      return { removed: [], added, bodyWrites, fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    const addedNonSub = plan.added.filter((e) => !e.isSubSkeleton);
    return {
      writtenEntries: addedNonSub,
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: [...addedNonSub],
      structureChanges: [],
    };
  }

  /**
   * Write `headingPath` so it sits immediately before or after the same-parent
   * sibling `anchorHeadingPath`. An existing section is written and then
   * reordered; a missing one is installed in the slot first, then filled.
   * Callers validate the anchor before calling.
   */
  async upsertSectionBeside(
    docPath: DocPath,
    headingPath: string[],
    heading: string,
    content: SectionBodyWithPotentialSubsections,
    anchorHeadingPath: string[],
    position: "before" | "after",
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const ref = new SectionRef(docPath, headingPath);
    const skeleton = await this.getWritableSkeleton(docPath);
    if (skeleton.has(headingPath)) {
      const result = await this.upsertSection(ref, heading, content);
      await this.reorderSiblingSection(docPath, headingPath, anchorHeadingPath, position);
      return result;
    }

    const parentPath = headingPath.slice(0, -1);
    const leaf = headingPath[headingPath.length - 1];
    const headingLevel = HeadingLevel.parse(await this.resolveTargetHeadingLevel(ref));
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      assertNoDuplicateSiblingHeadingCollision(ctx.findSiblingList(parentPath), {
        operation: "insert",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: "",
        proposedHeading: leaf,
        proposedHeadingLevel: headingLevel,
      });
      const { added, bodyWrites } = planSiblingInstall(
        ctx,
        docPath,
        { kind: position, anchorHeadingPath },
        [{ headingPath: [leaf], heading: leaf, headingLevel, body: "" }],
      );
      return { removed: [], added, bodyWrites, fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }

    const result = await this.upsertSection(ref, heading, content);
    return withInstalledContentEntries(result, plan.added);
  }

  /**
   * Write `headingPath` with no placement anchor. An existing section is
   * rewritten where it sits. A missing one is installed only where each new
   * segment would be the only real sibling; otherwise this rejects before
   * writing anything.
   */
  async upsertSectionAtOnlySiblingSlot(
    docPath: DocPath,
    headingPath: string[],
    heading: string,
    content: SectionBodyWithPotentialSubsections,
    opts?: { expandHeadingsIntoSections?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const ref = new SectionRef(docPath, headingPath);
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (headingPath.length === 0) {
      return await this.upsertSection(ref, heading, content, opts);
    }

    let firstMissing = 0;
    if (state === "live") {
      const existing = await this.getWritableSkeleton(docPath);
      while (firstMissing < headingPath.length && existing.has(headingPath.slice(0, firstMissing + 1))) {
        firstMissing++;
      }
      if (firstMissing === headingPath.length) {
        return await this.upsertSection(ref, heading, content, opts);
      }
      const parentPath = headingPath.slice(0, firstMissing);
      if (realSiblingHeadings(existing, parentPath).length > 0) {
        const parentLabel = parentPath.length === 0 ? "the document root" : `[${parentPath.join(" > ")}]`;
        throw new ProposalSectionReorderError(
          `Cannot create [${headingPath.join(" > ")}] in ${docPath} without a placement anchor: ` +
          `"${headingPath[firstMissing]}" would join existing sibling sections under ${parentLabel}.`,
        );
      }
    }

    let createdDocument = false;
    if (state === "missing") {
      await this.createDocument(docPath);
      createdDocument = true;
    }

    const parentPath = headingPath.slice(0, firstMissing);
    const chain: ParsedMarkdownRewriteSection[] = [];
    for (let i = firstMissing + 1; i <= headingPath.length; i++) {
      const segmentPath = headingPath.slice(0, i);
      chain.push({
        headingPath: segmentPath.slice(firstMissing),
        heading: segmentPath[segmentPath.length - 1],
        headingLevel: HeadingLevel.parse(await this.resolveTargetHeadingLevel(new SectionRef(docPath, segmentPath))),
        body: "",
      });
    }

    const skeleton = await this.getWritableSkeleton(docPath);
    const parentIsLeaf =
      parentPath.length > 0
      && skeleton.subtreeEntries(parentPath).length === 1;
    const parentBody = parentIsLeaf
      ? (await this.readEffectiveSectionBody(
          skeleton.requireContentEntryByHeadingPath(parentPath).absolutePath,
        )) ?? ""
      : null;

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "insert",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: "",
        proposedHeading: chain[0].heading,
        proposedHeadingLevel: chain[0].headingLevel,
      });
      const { added, bodyWrites } = planSiblingInstall(
        ctx,
        docPath,
        { kind: "only-child", parentPath },
        chain,
      );

      if (parentBody !== null) {
        const parentNode = ctx.locateStructuralNodeByHeadingPath(parentPath)?.node;
        if (!parentNode) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: leaf parent ` +
            `[${parentPath.join(" > ")}] vanished during upsertSectionAtOnlySiblingSlot`,
          );
        }
        ctx.addBodyHoldersToParents([parentNode]);
        const bodyHolder = parentNode.children.find((c) => isBodyHolderShape(c));
        if (!bodyHolder) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: addBodyHoldersToParents did not ` +
            `add a body holder for [${parentPath.join(" > ")}]`,
          );
        }
        const [bodyHolderEntry] = ctx.flattenNode(bodyHolder, parentPath, ctx.resolveSkeletonPathFor(parentPath));
        added.push(bodyHolderEntry);
        bodyWrites.push({ absolutePath: bodyHolderEntry.absolutePath, content: parentBody });
      }
      return { removed: [], added, bodyWrites, fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }

    const result = await this.upsertSection(ref, heading, content, opts);
    return {
      ...withInstalledContentEntries(result, plan.added),
      createdDocument: createdDocument || result.createdDocument === true,
    };
  }

  private async insertNewChildSectionBeside(
    docPath: DocPath,
    placement: { kind: "before" | "after"; anchorHeadingPath: string[] },
    heading: string,
    headingLevel: HeadingLevel,
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const parentHeadingPath = placement.anchorHeadingPath.slice(0, -1);
    if (parentHeadingPath.length === 0) {
      throw new Error(
        `insertNewChildSectionBeside called with a root-level anchor in ${docPath}. ` +
        `Root-level structure is owned by the document-level primitives, not the ` +
        `sub-skeleton-parent child insert.`,
      );
    }
    if (heading === "") {
      throw new Error(
        `insertNewChildSectionBeside in ${docPath}: heading must be non-empty; ` +
        `body holders are materialized via addBodyHoldersToParents, never inserted here.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    if (skeleton.subtreeEntries(parentHeadingPath).length <= 1) {
      throw new Error(
        `insertNewChildSectionBeside in ${docPath}: parent ` +
        `[${parentHeadingPath.join(" > ")}] is not a sub-skeleton parent.`,
      );
    }
    const sectionFile = generateSectionFilename(heading);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      assertNoDuplicateSiblingHeadingCollision(ctx.findSiblingList(parentHeadingPath), {
        operation: "insert",
        docPath,
        parentHeadingPath,
        targetSectionFile: sectionFile,
        proposedHeading: heading,
        proposedHeadingLevel: headingLevel,
      });
      const node: SkeletonNode = { heading, headingLevel, sectionFile, children: [] };
      ctx.placeSectionNodes(placement, [node]);
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentHeadingPath);
      const added = ctx.flattenNode(node, parentHeadingPath, parentSkeletonPath);
      return {
        removed: [],
        added,
        bodyWrites: [{ absolutePath: added[0].absolutePath, content: body as unknown as string }],
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    const addedNonSub = plan.added.filter((e) => !e.isSubSkeleton);
    return {
      writtenEntries: addedNonSub,
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: addedNonSub,
      structureChanges: [],
    };
  }

  private async replaceSubtreeDeletingOmittedSections(
    docPath: DocPath,
    headingPath: string[],
    parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
    options?: { leadingOrphanBody?: SectionBody },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const targetNode = skeleton.findStructuralNodeByHeadingPath(headingPath);
    if (!targetNode) {
      throw staleHeadingPath(docPath, headingPath, "cannot rewrite");
    }
    const targetContentEntry = skeleton.findContentEntryByHeadingPath(headingPath);
    if (!targetContentEntry) {
      throw staleHeadingPath(docPath, headingPath, "cannot rewrite content");
    }

    const parentPath = headingPath.slice(0, -1);
    const existingContentByResultingPath = new Map<string, string>();
    for (const existing of skeleton.subtreeEntries(headingPath)) {
      existingContentByResultingPath.set(headingPathKey(existing.headingPath), existing.sectionFile);
    }

    const leadingOrphanBody = (options?.leadingOrphanBody ?? "") as SectionBody;
    const hasOrphan = (leadingOrphanBody as string).length > 0;

    let preMutationMergeTarget: FlatEntry | null = null;
    let existingMergeBody: SectionBody = "" as SectionBody;
    if (hasOrphan) {
      preMutationMergeTarget = skeleton.findPreviousBodyHolder(targetNode.sectionFile);
      if (preMutationMergeTarget) {
        existingMergeBody = bodyFromDisk(
          (await this.readEffectiveSectionBody(preMutationMergeTarget.absolutePath)) ?? "",
        );
      }
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const located = ctx.locateStructuralNodeByHeadingPath(headingPath);
      if (!located || located.node.sectionFile !== targetNode.sectionFile) {
        throw staleHeadingPath(docPath, headingPath, "cannot rewrite");
      }
      const { siblings, node: oldNode } = located;
      for (const section of parsedSections) {
        if (section.headingPath.length !== 1) continue;
        assertNoDuplicateSiblingHeadingCollision(siblings, {
          operation: "rewrite",
          docPath,
          parentHeadingPath: parentPath,
          targetSectionFile: oldNode.sectionFile,
          proposedHeading: section.heading,
          proposedHeadingLevel: section.headingLevel,
        });
      }
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);
      const { added, bodyWrites } = planSiblingInstall(
        ctx,
        docPath,
        { kind: "replace", headingPath },
        parsedSections,
        existingContentByResultingPath,
      );

      if (hasOrphan) {
        if (preMutationMergeTarget) {
          bodyWrites.push({
            absolutePath: preMutationMergeTarget.absolutePath,
            content: appendToBody(existingMergeBody, leadingOrphanBody),
          });
        } else {
          const bfhEntry = ctx.createBfhAtFront();
          added.push(bfhEntry);
          bodyWrites.push({
            absolutePath: bfhEntry.absolutePath,
            content: leadingOrphanBody,
          });
        }
      }

      const survivingFiles = new Set(added.filter((e) => !e.isSubSkeleton).map((e) => e.sectionFile));
      const oldIdSurvived = survivingFiles.has(oldNode.sectionFile);
      const firstContentFile = added.find((e) => !e.isSubSkeleton)?.sectionFile ?? null;
      const fragmentKeyRemaps = oldIdSurvived
        ? []
        : [{ from: oldNode.sectionFile, to: firstContentFile }];

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps,
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    const addedNonSub = plan.added.filter((e) => !e.isSubSkeleton);
    const writtenEntries = [...addedNonSub];
    const liveReloadEntries = [...addedNonSub];
    if (preMutationMergeTarget) {
      writtenEntries.push(preMutationMergeTarget);
      liveReloadEntries.push(preMutationMergeTarget);
    }
    return {
      writtenEntries,
      removedContentEntries: plan.removed.filter((e) => !e.isSubSkeleton),
      fragmentKeyRemaps: plan.fragmentKeyRemaps,
      liveReloadEntries,
      structureChanges: [{
        oldEntry: flatEntryFromContentEntry(targetContentEntry),
        newEntries: addedNonSub,
      }],
    };
  }

  private async writeFreshDocumentFromParsedMarkdown(
    docPath: DocPath,
    parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  ): Promise<void> {
    const skeleton = await this.getWritableSkeleton(docPath);
    if (!skeleton.areSkeletonRootsEmpty) {
      throw new Error(
        `writeFreshDocumentFromParsedMarkdown(${docPath}): precondition violated — ` +
        `skeleton is not empty. ` +
        `This method only handles live-empty documents.`,
      );
    }
    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    const sectionsDirPath = `${overlaySkeletonPath}.sections`;
    let sectionsDirExists = false;
    try {
      await stat(sectionsDirPath);
      sectionsDirExists = true;
    } catch {
    }
    if (sectionsDirExists) {
      throw new Error(
        `writeFreshDocumentFromParsedMarkdown(${docPath}): precondition violated — ` +
        `overlay .sections/ directory already exists at ${sectionsDirPath}. ` +
        `This method only handles live-empty documents.`,
      );
    }

    const { replacementRoots, bodyByResultingHeadingPath } = buildReplacementRoots(
      [],
      parsedSections,
    );

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      ctx.addBodyHoldersToParents(replacementRoots);
      const roots = ctx.findSiblingList([]);
      roots.splice(0, 0, ...replacementRoots);

      const added: FlatEntry[] = [];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor([]);
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, [], parentSkeletonPath));
      }

      const bodyWrites = buildBodyWritesForReplacement(docPath, added, bodyByResultingHeadingPath);

      return {
        removed: [],
        added,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
  }

  /** Insert an empty before-first-heading section at the front of the roots —
   *  the only slot a BFH may occupy. The caller has checked none exists. */
  private async createEmptyBfhAtFront(docPath: DocPath): Promise<FlatEntry> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const bfhEntry = ctx.createBfhAtFront();
      return {
        removed: [],
        added: [bfhEntry],
        bodyWrites: [{ absolutePath: bfhEntry.absolutePath, content: "" }],
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    return plan.added[0];
  }

  async tombstoneDocumentExplicit(docPath: DocPath): Promise<void> {
    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    await rm(overlaySkeletonPath, { force: true });
    await rm(`${overlaySkeletonPath}.sections`, { recursive: true, force: true });
    await writeTombstoneMarker(docPath, this.overlayRoot);
  }
}
