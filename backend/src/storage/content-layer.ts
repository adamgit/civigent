import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DocumentSkeleton,
  DocumentSkeletonInternal,
  resolveSkeletonPath,
  skeletonFileExists,
  tombstoneFileExists,
  writeTombstoneMarker,
  generateSectionFilename,
  generateBeforeFirstHeadingFilename,
  headingsEqual,
  listSkeletonEntriesAtRoot,
  type ContentEntry,
  type FlatEntry,
  type HeadingRemovalEffect,
  type ProposalDocumentState,
  type SkeletonNode,
  type StructuralMutationPlan,
} from "./document-skeleton.js";
import { docPathToContentRelativeFsPath } from "./path-utils.js";
import { directoryExists, pathExists } from "./fs-primitives.js";
import { staleHeadingPath } from "./skeleton-errors.js";
import type { DocStructureNode } from "../types/shared.js";
import { DocPath, HeadingLevel } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { bodyFromDisk, bodyFromParser, stripHeadingFromFragment, buildFragmentContent, assembleFragments, fragmentFromBodyHolder, stripLeadingNewlines, appendToBody, fragmentFromExternalContent, type SectionBody, type FragmentContent, type SectionBodyWithPotentialSubsections } from "./section-formatting.js";
import { isBodyHolderShape, isDocumentBeforeFirstHeading, parsedSectionIsHeadless } from "./section-shape.js";
import type { ParsedSection } from "./markdown-sections.js";

async function writeBodyFile(entry: ContentEntry | FlatEntry, content: string): Promise<void> {
  if ("kind" in entry) {
    if (entry.kind !== "content_entry") {
      throw new Error("writeBodyFile only accepts content entries.");
    }
  } else if (entry.isSubSkeleton) {
    return;
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
  if (effect.mergeTarget && effect.mergeTarget.mergedBody !== null) {
    writtenEntries.push(effect.mergeTarget.newEntry);
  }
  return {
    writtenEntries,
    removedContentEntries: effect.removedTargetEntries.filter((e) => !e.isSubSkeleton),
    fragmentKeyRemaps: effect.fragmentKeyChanges,
    liveReloadEntries: [...writtenEntries],
    structureChanges: [{ oldEntry: flatEntryFromContentEntry(deletedEntry), newEntries: [] }],
  };
}

type ParsedMarkdownRewriteSection = Readonly<{
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

  for (const section of parsedSections) {
    const parsedHeadingPath = [...section.headingPath];
    const parsedKey = headingPathKey(parsedHeadingPath);
    if (nodesByParsedHeadingPath.has(parsedKey)) {
      throw new Error(
        `Parsed markdown contains duplicate heading path [${parsedHeadingPath.join(" > ")}].`,
      );
    }

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
  for (const sibling of siblings) {
    if (sibling.sectionFile === args.targetSectionFile) continue;
    if (sibling.headingLevel !== args.proposedHeadingLevel) continue;
    if (!headingsEqual(sibling.heading, args.proposedHeading)) continue;
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
  removedContentEntries: FlatEntry[];
  fragmentKeyRemaps: StructuralMutationPlan["fragmentKeyRemaps"];
  liveReloadEntries: FlatEntry[];
  structureChanges: Array<{
    oldEntry: FlatEntry;
    newEntries: FlatEntry[];
  }>;
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
    if (!(await skeletonFileExists(docPath, this.contentRoot))) {
      if (await directoryExists(resolveSkeletonPath(docPath, this.contentRoot))) {
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

    try {
      return bodyFromDisk(await readFile(entry.absolutePath, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      throw new SectionNotFoundError(
        `Section not found: (${ref.docPath}, [${ref.headingPath.join(" > ")}]).`,
      );
    }
  }

  async readSubtree(
    docPath: DocPath,
    headingPath: string[],
  ): Promise<Array<{ headingPath: string[]; heading: string; headingLevel: HeadingLevel; bodyContent: string }>> {
    if (headingPath.length === 0) {
      throw new Error(
        `ContentLayer.readSubtree(${docPath}, []) is not allowed — use getSectionList(docPath) + readSection(...) for whole-document enumeration, or readSection(ref(docPath, [])) for before-first-heading.`,
      );
    }
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
    if (this.overlayRoot !== this.canonicalRoot && (await tombstoneFileExists(docPath, this.overlayRoot))) {
      return "tombstone";
    }
    if (await skeletonFileExists(docPath, this.overlayRoot)) return "live";
    if (await skeletonFileExists(docPath, this.canonicalRoot)) return "live";
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

  private async loadWritableSkeleton(docPath: DocPath): Promise<DocumentSkeletonInternal> {
    const structureRoot = (await skeletonFileExists(docPath, this.overlayRoot))
      ? this.overlayRoot
      : this.canonicalRoot;
    const nodes = await DocumentSkeletonInternal.loadNodesFromRoot(docPath, structureRoot);
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
    const deletedSectionFiles = this.overlayRoot !== this.canonicalRoot && this.deletedSectionFilesProvider
      ? await this.deletedSectionFilesProvider(docPath)
      : undefined;
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
      return await this.writeSectionBodyVerbatim(ref, content as unknown as SectionBody);
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
    if (!skeleton.has(ref.headingPath)) {
      await this.materializeAncestorHeadings(ref.docPath, ref.headingPath);
      skeleton = await this.getWritableSkeleton(ref.docPath);
    }
    const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);

    const newBody = bodyFromDisk(body as unknown as string);
    const currentBody = bodyFromDisk(
      (await this.readEffectiveSectionBody(entry.absolutePath)) ?? "",
    );
    if ((currentBody as string) === (newBody as string)) {
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

  async splitBeforeFirstHeadingPromotingHeadings(
    docPath: DocPath,
    bfhFragmentMarkdown: string,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const parsed = getParser().parseDocumentMarkdown(bfhFragmentMarkdown);
    const hasOrphan = parsed.length > 0 && parsed[0].headingLevel === 0 && parsed[0].heading === "";
    const orphanBody = (hasOrphan ? (parsed[0].body as unknown as string) : "") as unknown as SectionBody;
    const headed = hasOrphan ? parsed.slice(1) : parsed;

    if (headed.length === 0) {
      return await this.writeSectionBodyVerbatim(new SectionRef(docPath, []), orphanBody);
    }

    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocument(docPath);
    }
    let skeleton = await this.getWritableSkeleton(docPath);
    if (!skeleton.has([])) {
      await this.materializeAncestorHeadings(docPath, []);
      skeleton = await this.getWritableSkeleton(docPath);
    }
    const bfhEntry = skeleton.requireContentEntryByHeadingPath([]);

    if (skeleton.findStructuralNodeByHeadingPath([headed[0].heading])) {
      return {
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      };
    }

    const { replacementRoots, bodyByResultingHeadingPath } = buildReplacementRoots(
      [],
      headed,
      new Map(),
    );

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const bfhIdx = ctx.roots.findIndex((n) => isBodyHolderShape(n));
      if (bfhIdx < 0) {
        throw new Error(
          `Skeleton integrity error in ${docPath}: BFH expected at front of roots for split reflection.`,
        );
      }
      ctx.addBodyHoldersToParents(replacementRoots);
      ctx.roots.splice(bfhIdx + 1, 0, ...replacementRoots);

      const added: FlatEntry[] = [];
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, [], ctx.resolveSkeletonPathFor([])));
      }
      const bodyWrites = buildBodyWritesForReplacement(docPath, added, bodyByResultingHeadingPath);
      bodyWrites.push({ absolutePath: bfhEntry.absolutePath, content: orphanBody as unknown as string });
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
    const writtenEntries = [...addedNonSub, flatEntryFromContentEntry(bfhEntry)];
    return {
      writtenEntries,
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: writtenEntries,
      structureChanges: [{
        oldEntry: flatEntryFromContentEntry(bfhEntry),
        newEntries: writtenEntries,
      }],
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
    if (ref.headingPath.length === 0) {
      throw new Error(
        `upsertSectionFromMarkdownCore called with headingPath=[] in ${ref.docPath}. ` +
        `A '[]' section write targets the before-first-heading body only — route it ` +
        `through writeSectionBodyVerbatim(...); whole-document writes use ` +
        `upsertDocumentFromMarkdown(...).`,
      );
    }
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocument(ref.docPath);
    }
    let skeleton = await this.getWritableSkeleton(ref.docPath);
    if (!skeleton.has(ref.headingPath)) {
      await this.materializeAncestorHeadings(ref.docPath, ref.headingPath);
      skeleton = await this.getWritableSkeleton(ref.docPath);
    }

    const parsedSections = getParser().parseDocumentMarkdown(markdown);

    const hasOrphan = parsedSections.length > 0
      && parsedSections[0].headingLevel === 0
      && parsedSections[0].heading === "";
    const leadingOrphanBody = (hasOrphan
      ? (parsedSections[0].body as unknown as string)
      : "") as SectionBody;
    const headedSections = hasOrphan ? parsedSections.slice(1) : parsedSections;

    if (opts?.requireMergeToPrevious && headedSections.length > 0) {
      throw new Error(
        `Illegal arguments: upsertSectionMergingToPrevious cannot target a headed section with headed markdown content.`,
      );
    }

    if (headedSections.length === 0) {
      const deletedEntry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      const effect = await this.removeHeading(ref.docPath, ref.headingPath, leadingOrphanBody);
      return upsertResultFromHeadingRemoval(effect, deletedEntry);
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
        return {
          writtenEntries: [flatEntryFromContentEntry(entry)],
          removedContentEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries: [flatEntryFromContentEntry(entry)],
          structureChanges: [],
        };
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
      return {
        writtenEntries: [flatEntryFromContentEntry(newEntry)],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [flatEntryFromContentEntry(newEntry)],
        structureChanges: [{
          oldEntry: flatEntryFromContentEntry(oldEntry),
          newEntries: [flatEntryFromContentEntry(newEntry)],
        }],
      };
    }

    if (
      !hasOrphan
      && (await this.isIdentityUpsert(skeleton, ref.headingPath, headedSections))
    ) {
      return {
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      };
    }

    if (targetIsSubSkeletonParent && headedSections.length > 1) {
      return await this.applyMultiHeadingPayloadToSubSkeletonParent(
        ref,
        headedSections,
        leadingOrphanBody,
      );
    }

    if (headedSections.length === 1 && !targetIsSubSkeletonParent) {
      const single = headedSections[0];
      const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.headingLevel === entry.headingLevel) {
        const writtenEntries: FlatEntry[] = [flatEntryFromContentEntry(entry)];
        const liveReloadEntries: FlatEntry[] = [flatEntryFromContentEntry(entry)];

        if (hasOrphan) {
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
            return await this.replaceSubtreeDeletingOmittedSections(
              ref.docPath,
              ref.headingPath,
              headedSections,
              { leadingOrphanBody },
            );
          }
        }

        await this.writeOverlayBodyFile(
          ref.docPath,
          entry,
          single.body as unknown as string,
        );

        return {
          writtenEntries,
          removedContentEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries,
          structureChanges: [],
        };
      }
    }

    return await this.replaceSubtreeDeletingOmittedSections(
      ref.docPath,
      ref.headingPath,
      headedSections,
      { leadingOrphanBody },
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
      if (!skeleton.has(resultingPath) && parentIsSubSkeletonParent) {
        const directChildren = skeleton.subtreeEntries(parentPath)
          .filter((e) => e.headingPath.length === parentPath.length + 1);
        const prevLeaf = lastDispatchedLeafByParent.get(headingPathKey(parentPath)) ?? null;
        let insertIndex = 0;
        if (prevLeaf !== null) {
          const prevIdx = directChildren.findIndex(
            (e) => headingsEqual(e.headingPath[parentPath.length], prevLeaf),
          );
          if (prevIdx < 0) {
            throw new Error(
              `Skeleton integrity error in ${ref.docPath}: dispatched sibling ` +
              `"${prevLeaf}" not found under [${parentPath.join(" > ")}] while ` +
              `positioning "${parsed.heading}".`,
            );
          }
          insertIndex = prevIdx + 1;
        }
        mergeInto(await this.insertNewChildSectionAtPosition(
          ref.docPath,
          parentPath,
          insertIndex,
          parsed.heading,
          parsed.headingLevel,
          parsed.body as unknown as SectionBody,
        ));
      } else {
        mergeInto(await this.upsertSectionFromMarkdownCore(
          new SectionRef(ref.docPath, resultingPath),
          singleSectionMarkdown(parsed),
        ));
      }
      lastDispatchedLeafByParent.set(headingPathKey(parentPath), parsed.heading);
    }

    return aggregate;
  }

  private async isIdentityUpsert(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
    parsedSections: ReadonlyArray<ParsedSection>,
  ): Promise<boolean> {
    if (headingPath.length === 0) {
      throw new Error(
        `isIdentityUpsert called with headingPath=[] in ${skeleton.docPath}. ` +
        `BFH identity is checked against the BFH body alone in ` +
        `writeSectionBodyVerbatim(...); '[]' is never a whole-document ` +
        `identity selector here.`,
      );
    }
    if (parsedSections.length === 0) return false;

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

  private async readEffectiveSectionBody(proposalBodyPath: string): Promise<string | null> {
    try {
      return await readFile(proposalBodyPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const canonicalPath = path.join(
      this.canonicalRoot,
      path.relative(this.overlayRoot, proposalBodyPath),
    );
    try {
      return await readFile(canonicalPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return null;
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

    return effect;
  }


  async deleteSubtree(docPath: DocPath, headingPath: string[]): Promise<FlatEntry[]> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      if (headingPath.length === 0) {
        const bfhIdx = ctx.roots.findIndex((n) => isBodyHolderShape(n));
        if (bfhIdx < 0) {
          throw staleHeadingPath(docPath, headingPath, "no before-first-heading section to delete");
        }
        const bfhNode = ctx.roots[bfhIdx];
        const removed = ctx.flattenNode(bfhNode, [], resolveSkeletonPath(docPath, this.overlayRoot));
        ctx.roots.splice(bfhIdx, 1);
        return {
          removed,
          added: [],
          bodyWrites: [],
          fragmentKeyRemaps: removed.map((e) => ({ from: e.sectionFile, to: null })),
        } satisfies StructuralMutationPlan;
      }

      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot delete subtree");
      }
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(siblings[idx], parentPath, parentSkeletonPath);
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
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot rename");
      }

      const oldNode = siblings[idx];
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: oldNode.sectionFile,
        proposedHeading: newHeading,
        proposedHeadingLevel: oldNode.headingLevel,
      });
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
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
    const target = headingPath[headingPath.length - 1];
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot retitle sub-skeleton parent");
      }
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
    const target = headingPath[headingPath.length - 1];
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) throw staleHeadingPath(docPath, headingPath, "cannot retitle");
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
    newParentPath: string[],
    newHeadingLevel: HeadingLevel,
  ): Promise<{ removed: FlatEntry[]; added: FlatEntry[] }> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot move the before-first-heading section in ${docPath}.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);

    const preEntries = skeleton.subtreeEntries(headingPath);
    const preBodies = new Map<string, string>();
    for (const entry of preEntries) {
      if (entry.isSubSkeleton) continue;
      const relKey = entry.headingPath.slice(headingPath.length - 1).join("\u0000");
      preBodies.set(relKey, (await this.readEffectiveSectionBody(entry.absolutePath)) ?? "");
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const sourceSiblings = ctx.findSiblingList(parentPath);
      const sourceIdx = sourceSiblings.findIndex((n) => headingsEqual(n.heading, target));
      if (sourceIdx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot move (source)");
      }
      const movedNode = sourceSiblings[sourceIdx];

      const destSiblingsCheck = ctx.findSiblingList(newParentPath);
      assertNoDuplicateSiblingHeadingCollision(destSiblingsCheck, {
        operation: "move",
        docPath,
        parentHeadingPath: newParentPath,
        targetSectionFile: movedNode.sectionFile,
        proposedHeading: movedNode.heading,
        proposedHeadingLevel: newHeadingLevel,
      });

      const removed = ctx.flattenNode(movedNode, parentPath, ctx.resolveSkeletonPathFor(parentPath));
      sourceSiblings.splice(sourceIdx, 1);

      const relabeled: SkeletonNode = {
        heading: movedNode.heading,
        headingLevel: newHeadingLevel,
        sectionFile: movedNode.sectionFile,
        children: movedNode.children,
      };

      const destSiblings = ctx.findSiblingList(newParentPath);
      destSiblings.push(relabeled);

      const destSkeletonPath = ctx.resolveSkeletonPathFor(newParentPath);
      if (newParentPath.length > 0) {
        const grandparentPath = newParentPath.slice(0, -1);
        const parentSiblings = ctx.findSiblingList(grandparentPath);
        const parentNode = parentSiblings.find((n) =>
          headingsEqual(n.heading, newParentPath[newParentPath.length - 1]),
        );
        if (parentNode) ctx.addBodyHoldersToParents([parentNode]);
      }
      const added = ctx.flattenNode(relabeled, newParentPath, destSkeletonPath);

      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
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
      const siblings = ctx.findSiblingList(parentPath);
      const sourceLeaf = headingPath[headingPath.length - 1];
      const targetLeaf = targetHeadingPath[targetHeadingPath.length - 1];
      const sourceIdx = siblings.findIndex((n) => headingsEqual(n.heading, sourceLeaf));
      if (sourceIdx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot reorder (source)");
      }
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

  private async insertNewChildSectionAtPosition(
    docPath: DocPath,
    parentHeadingPath: string[],
    insertIndex: number,
    heading: string,
    headingLevel: HeadingLevel,
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    if (parentHeadingPath.length === 0) {
      throw new Error(
        `insertNewChildSectionAtPosition called with parentHeadingPath=[] in ${docPath}. ` +
        `Root-level structure is owned by the document-level primitives, not the ` +
        `sub-skeleton-parent child insert.`,
      );
    }
    if (heading === "") {
      throw new Error(
        `insertNewChildSectionAtPosition in ${docPath}: heading must be non-empty; ` +
        `body holders are materialized via addBodyHoldersToParents, never inserted here.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    if (skeleton.subtreeEntries(parentHeadingPath).length <= 1) {
      throw new Error(
        `insertNewChildSectionAtPosition in ${docPath}: parent ` +
        `[${parentHeadingPath.join(" > ")}] is not a sub-skeleton parent.`,
      );
    }
    const sectionFile = generateSectionFilename(heading);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const children = ctx.findSiblingList(parentHeadingPath);
      assertNoDuplicateSiblingHeadingCollision(children, {
        operation: "insert",
        docPath,
        parentHeadingPath,
        targetSectionFile: sectionFile,
        proposedHeading: heading,
        proposedHeadingLevel: headingLevel,
      });
      const bodyHolderOffset = children.length > 0 && isBodyHolderShape(children[0]) ? 1 : 0;
      const realChildCount = children.length - bodyHolderOffset;
      if (insertIndex < 0 || insertIndex > realChildCount) {
        throw new Error(
          `insertNewChildSectionAtPosition in ${docPath}: insertIndex ${insertIndex} ` +
          `is out of range for parent [${parentHeadingPath.join(" > ")}] with ` +
          `${realChildCount} child section(s).`,
        );
      }
      const node: SkeletonNode = { heading, headingLevel, sectionFile, children: [] };
      children.splice(bodyHolderOffset + insertIndex, 0, node);
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
    if (headingPath.length === 0) {
      throw new Error(
        `replaceSubtreeDeletingOmittedSections called with headingPath=[] in ${docPath}. ` +
        `'[]' is not a subtree target — a before-first-heading write is body-only ` +
        `(writeSectionBodyVerbatim(...)) and a whole-document rewrite is a ` +
        `document-level operation (upsertDocumentFromMarkdown(...)).`,
      );
    }
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
    const { replacementRoots, bodyByResultingHeadingPath } = buildReplacementRoots(
      parentPath,
      parsedSections,
      existingContentByResultingPath,
    );

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
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => n.sectionFile === targetNode.sectionFile);
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot rewrite");
      }
      const oldNode = siblings[idx];
      for (const root of replacementRoots) {
        if (root.heading === "") continue;
        assertNoDuplicateSiblingHeadingCollision(siblings, {
          operation: "rewrite",
          docPath,
          parentHeadingPath: parentPath,
          targetSectionFile: oldNode.sectionFile,
          proposedHeading: root.heading,
          proposedHeadingLevel: root.headingLevel,
        });
      }
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);
      ctx.addBodyHoldersToParents(replacementRoots);
      siblings.splice(idx, 1, ...replacementRoots);

      const added: FlatEntry[] = [];
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, parentPath, parentSkeletonPath));
      }

      const bodyWrites = buildBodyWritesForReplacement(docPath, added, bodyByResultingHeadingPath);

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

  private async materializeAncestorHeadings(docPath: DocPath, headingPath: string[]): Promise<FlatEntry[]> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const created: FlatEntry[] = [];

    let leafParentPath: string[] | null = null;
    let leafParentBody: SectionBody | null = null;
    let bhAbsolutePathForMigration: string | null = null;
    for (let i = 1; i < headingPath.length; i++) {
      const ancestorPath = headingPath.slice(0, i);
      if (!skeleton.has(ancestorPath)) break;
      const isLeaf = skeleton.subtreeEntries(ancestorPath).length === 1;
      if (isLeaf) {
        leafParentPath = ancestorPath;
      }
    }
    if (leafParentPath !== null) {
      const entry = skeleton.requireContentEntryByHeadingPath(leafParentPath);
      leafParentBody = bodyFromDisk((await this.readEffectiveSectionBody(entry.absolutePath)) ?? "");
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const newlyAdded: FlatEntry[] = [];

      if (headingPath.length === 0 && !skeleton.has([])) {
        const bfhFile = generateBeforeFirstHeadingFilename();
        const bfhNode: SkeletonNode = { heading: "", headingLevel: HeadingLevel.beforeFirstHeading, sectionFile: bfhFile, children: [] };
        ctx.roots.unshift(bfhNode);
        newlyAdded.push(...ctx.flattenNode(bfhNode, [], resolveSkeletonPath(docPath, this.overlayRoot)));
      }

      let topNewParentPath: string[] | null = null;
      const newSegmentPaths: string[][] = [];
      for (let i = 1; i <= headingPath.length; i++) {
        const ancestorPath = headingPath.slice(0, i);
        if (skeleton.has(ancestorPath)) continue;
        if (topNewParentPath === null) topNewParentPath = ancestorPath;
        const parentPath = ancestorPath.slice(0, -1);
        const parentSiblings = ctx.findSiblingList(parentPath);
        const headingLevel = HeadingLevel.parse(parentPath.length === 0
          ? 1
          : skeleton.requireStructuralNodeByHeadingPath(parentPath).headingLevel + 1);
        const heading = ancestorPath[ancestorPath.length - 1];
        const node: SkeletonNode = {
          heading,
          headingLevel,
          sectionFile: generateSectionFilename(heading),
          children: [],
        };
        parentSiblings.push(node);
        newSegmentPaths.push([...ancestorPath]);
      }

      let migratedBhHeadingPath: string[] | null = null;
      if (leafParentPath !== null && leafParentBody !== null) {
        const grandparentPath = leafParentPath.slice(0, -1);
        const grandparentSiblings = ctx.findSiblingList(grandparentPath);
        const lastSegment = leafParentPath[leafParentPath.length - 1];
        const parentNode = grandparentSiblings.find((n) => headingsEqual(n.heading, lastSegment));
        if (!parentNode) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: leaf parent ` +
            `[${leafParentPath.join(" > ")}] vanished during materializeAncestorHeadings`,
          );
        }
        ctx.addBodyHoldersToParents([parentNode]);
        const bh = parentNode.children[0];
        if (!bh || bh.headingLevel !== 0 || bh.heading !== "") {
          throw new Error(
            `Skeleton integrity error in ${docPath}: addBodyHoldersToParents ` +
            `did not prepend body holder for [${leafParentPath.join(" > ")}]`,
          );
        }
        const parentSkeletonPath = ctx.resolveSkeletonPathFor(leafParentPath);
        bhAbsolutePathForMigration = path.join(`${parentSkeletonPath}.sections`, bh.sectionFile);
        migratedBhHeadingPath = [...leafParentPath];
        if (topNewParentPath === null || leafParentPath.length < topNewParentPath.length) {
          topNewParentPath = [...leafParentPath];
        }
      }

      for (const segPath of newSegmentPaths) {
        const node = ctx.findSiblingList(segPath.slice(0, -1))
          .find((n) => headingsEqual(n.heading, segPath[segPath.length - 1]));
        if (node) ctx.addBodyHoldersToParents([node]);
      }

      if (topNewParentPath !== null) {
        const topParentPath = topNewParentPath.slice(0, -1);
        const topNode = ctx.findSiblingList(topParentPath)
          .find((n) => headingsEqual(n.heading, topNewParentPath![topNewParentPath!.length - 1]));
        if (!topNode) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: top new ancestor ` +
            `[${topNewParentPath.join(" > ")}] vanished during materializeAncestorHeadings`,
          );
        }
        newlyAdded.push(
          ...ctx.flattenNode(topNode, topParentPath, ctx.resolveSkeletonPathFor(topParentPath)),
        );
      }

      const migratedBhKey = migratedBhHeadingPath !== null
        ? migratedBhHeadingPath.join("\u0000")
        : null;
      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      const seenBodyPaths = new Set<string>();
      for (const e of newlyAdded) {
        if (e.isSubSkeleton) continue;
        if (seenBodyPaths.has(e.absolutePath)) continue;
        seenBodyPaths.add(e.absolutePath);
        const isMigratedBh =
          migratedBhKey !== null
          && e.headingLevel === 0
          && e.heading === ""
          && e.headingPath.join("\u0000") === migratedBhKey;
        bodyWrites.push({
          absolutePath: e.absolutePath,
          content: isMigratedBh ? (leafParentBody as unknown as string) : "",
        });
      }

      return {
        removed: [],
        added: newlyAdded,
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
    created.push(...plan.added);
    return created;
  }

  async tombstoneDocumentExplicit(docPath: DocPath): Promise<void> {
    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    await rm(overlaySkeletonPath, { force: true });
    await rm(`${overlaySkeletonPath}.sections`, { recursive: true, force: true });
    await writeTombstoneMarker(docPath, this.overlayRoot);
  }
}
