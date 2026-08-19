/**
 * ProposalEditor — read/write proposal-scoped facade over a proposal content
 * tree, exposed through `DocumentSkeleton`.
 *
 * Extends the full `ProposalReader` surface and adds:
 *   - write / replace section content, with ATOMIC auto-creation of a missing
 *     document, missing leaf heading, and all missing ancestors (spec
 *     `04-decisions-and-apis.md` "Auto-creation within ProposalEditor");
 *   - whole-document write from markdown (parser-driven structural expansion);
 *   - proposal-scoped structural ops (create/move/rename/delete section,
 *     rename/delete document) returning the engine's detailed remap/result
 *     codes;
 *   - document delete/rename via tombstone semantics WITHOUT exposing the
 *     `{skeletonPath}.tombstone` storage format (spec "Tombstone-file
 *     pattern");
 *   - `replayDocumentFromGitCommit` — no-normalization historical replay.
 *
 * The proposal-internal storage layout is never exposed to callers.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  ProposalShadowContentLayer,
  type UpsertSectionFromMarkdownDetailedResult,
} from "./content-layer.js";
import { ProposalReader } from "./proposal-reader.js";
import { proposalContentRoot } from "./proposal-repository.js";
import { deleteProposalSubtree } from "./proposal-subtree-deletion.js";
import { getContentRoot, getDataRoot, getContentGitPrefix } from "./data-root.js";
import { docPathToContentRelativeFsPath } from "./path-utils.js";
import { DocPath } from "../types/shared.js";
import type { HeadingLevel } from "../types/shared.js";
import { resolveSkeletonPath } from "./document-skeleton.js";
import { gitShowFile, extractHistoricalTree } from "./git-repo.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import type { ContentEntry, FlatEntry } from "./document-skeleton.js";
import { sectionWriteInputFromExternal, type SectionBody, type SectionBodyWithPotentialSubsections } from "./section-formatting.js";
import type { ProposalId, ProposalStatus } from "../types/shared.js";
import type { ProposalSubtreeMutationResult } from "./proposal-facade-types.js";

export class ProposalEditor extends ProposalReader {
  /**
   * Open an editor for a proposal whose status (hence content-root location)
   * is already known. The canonical root defaults to the live content root.
   */
  static open(proposalId: ProposalId, status: ProposalStatus, canonicalRoot: string = getContentRoot()): ProposalEditor {
    return new ProposalEditor(proposalId, proposalContentRoot(proposalId, status), canonicalRoot);
  }

  // The protected ProposalReader constructor is reused as-is; ProposalEditor
  // shares the same private ProposalShadowContentLayer for both reads and
  // writes.

  // ─── Content writes ───────────────────────────────────────────────

  /**
   * Write / replace the content at a heading path. Missing document, missing
   * leaf heading, and all missing ancestors are auto-created atomically as
   * part of this one operation (the engine creates the proposal-scoped
   * skeleton from canonical when present else fresh-empty, materializes
   * ancestors root-to-leaf, then writes the body — callers never observe a
   * partial heading chain).
   *
   * For a real (non-empty) heading path, `content` is treated as section
   * markdown and routed through the parser-driven upsert path so embedded
   * headings expand into real sections (NOT a body-only write).
   *
   * For the before-first-heading target (`headingPath === []`, `heading === ""`)
   * the write is BODY-ONLY: `content` is stored verbatim as the BFH body and is
   * NEVER parsed for structure. Embedded heading syntax stays literal text and
   * cannot create/rename/reorder headed sections. Whole-document structural
   * writes use `writeDocumentFromMarkdown(...)`, never a `[]` section write.
   *
   * `heading` is the leaf heading text (empty string when targeting the
   * before-first-heading root section, i.e. `headingPath === []`).
   */
  async writeSection(
    docPath: DocPath,
    headingPath: string[],
    heading: string,
    content: SectionBodyWithPotentialSubsections,
    opts?: { expandHeadingsIntoSections?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    return this.shadow.upsertSection(new SectionRef(docPath, headingPath), heading, content, opts);
  }

  /**
   * CRDT MATERIALIZATION ONLY. Store a touched live section's body VERBATIM at
   * its existing identity — topology-neutral (no parsing, no structural
   * expansion), id-preserving. This is the per-edit (keystroke-rate)
   * write-through: embedded heading syntax stays literal body text and never
   * becomes a section on a keystroke. Structural promotion of a settled
   * embedded heading happens once, at quiescence normalization, NOT here.
   *
   * Every section identity — including BFH (`headingPath: []`) — uses this same
   * contract. REST / MCP / manual proposal editing / import / restore must keep
   * using the parser-driven `writeSection(...)`, which intentionally expands
   * embedded headings into real sections.
   */
  async writeSectionBodyVerbatim(
    docPath: DocPath,
    headingPath: string[],
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    return this.shadow.writeSectionBodyVerbatim(new SectionRef(docPath, headingPath), body);
  }

  /**
   * QUIESCENCE REFLECTION ONLY. Promote a settled `## Heading` that was typed
   * into the before-first-heading (BFH) body into a real top-level section,
   * preserving the pre-heading orphan as the BFH body and every existing
   * section's id. The root-split counterpart of the parser-driven section-split
   * reflection (`writeSection(headedPath, …, { expandHeadingsIntoSections })`).
   * Idempotent: a no-op once the heading is already promoted.
   */
  async splitBeforeFirstHeading(
    docPath: DocPath,
    bfhFragmentMarkdown: string,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    return this.shadow.splitBeforeFirstHeadingPromotingHeadings(docPath, bfhFragmentMarkdown);
  }

  /**
   * Replace an entire document from assembled markdown. Parses into sections,
   * (re)builds the proposal skeleton to match heading structure, writes
   * per-section bodies — the single normalize-on-write whole-document path.
   * Auto-creates the document when missing; overwrites an existing live one.
   *
   * Callers that need the resulting section manifest read it back via
   * `listHeadingPaths(...)` after this resolves.
   */
  async writeDocumentFromMarkdown(docPath: DocPath, markdown: string): Promise<void> {
    await this.shadow.upsertDocumentFromMarkdown(docPath, markdown);
  }

  // ─── Structural section operations ────────────────────────────────

  /**
   * Create a section at a heading path with optional initial content. Routes
   * through the same auto-creating parser-driven upsert path as
   * `writeSection`, so markdown structural-expansion semantics are preserved.
   */
  async createSection(
    docPath: DocPath,
    headingPath: string[],
    heading: string,
    initialContent: SectionBodyWithPotentialSubsections = sectionWriteInputFromExternal(""),
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    return this.shadow.upsertSection(new SectionRef(docPath, headingPath), heading, initialContent);
  }

  /** Move a subtree under a new parent at a specified level. */
  async moveSection(
    docPath: DocPath,
    headingPath: string[],
    newParentPath: string[],
    newHeadingLevel: HeadingLevel,
  ): Promise<ProposalSubtreeMutationResult> {
    return this.shadow.moveSubtree(docPath, headingPath, newParentPath, newHeadingLevel);
  }

  /**
   * Reorder `headingPath` relative to a same-parent sibling, placing it before or
   * after `targetHeadingPath`. Pure positional reorder (no key remap, no body
   * rewrite). Two callers: live cross-section drag/drop
   * (`requestDocSessionMove` / MW-10) and proposal-scoped mutate
   * (`reorder_section` and `create_section` placement via
   * `mutateProposalContent`).
   */
  async reorderSection(
    docPath: DocPath,
    headingPath: string[],
    targetHeadingPath: string[],
    position: "before" | "after",
  ): Promise<void> {
    return this.shadow.reorderSiblingSection(docPath, headingPath, targetHeadingPath, position);
  }

  /** Rename a heading in place, preserving descendants and body content. */
  async renameSection(
    docPath: DocPath,
    headingPath: string[],
    newHeading: string,
  ): Promise<ContentEntry> {
    return this.shadow.renameHeading(docPath, headingPath, newHeading);
  }

  /** Delete a subtree (target section plus all descendants). Explicit subtree
   *  deletion ONLY — heading removal (descendants preserved) is the narrow
   *  `proposal-heading-removal.ts` module, never this. */
  async deleteSubtree(docPath: DocPath, headingPath: string[]): Promise<FlatEntry[]> {
    return deleteProposalSubtree(this.proposalId, this.shadow, docPath, headingPath);
  }

  /**
   * Id-preserving in-place retitle/re-level + body rewrite (WS-2 rename /
   * level-change reflection). Keeps the section-file id so the live fragment key
   * stays valid. Returns the resulting content entry.
   */
  async retitleSection(
    docPath: DocPath,
    headingPath: string[],
    newHeading: string,
    newHeadingLevel: HeadingLevel,
    body: SectionBody,
  ): Promise<ContentEntry> {
    return this.shadow.retitleSectionInPlace(docPath, headingPath, newHeading, newHeadingLevel, body);
  }

  // ─── Document-level structural operations (tombstone semantics) ────

  /**
   * Create a fresh empty document in the proposal.
   */
  async createDocument(docPath: DocPath): Promise<void> {
    await this.shadow.createDocument(docPath);
  }

  /**
   * Delete a document via tombstone semantics. The proposal records a
   * pending-deletion tombstone for `docPath`; the `{skeletonPath}.tombstone`
   * storage format is never exposed. Returns the canonical heading paths that
   * will go away when the proposal commits (for building proposal metadata).
   */
  async deleteDocument(docPath: DocPath): Promise<string[][]> {
    return this.shadow.tombstoneDocument(docPath);
  }

  /**
   * Rename a document: copy the effective source document to the destination
   * path inside the proposal, then tombstone the source path. Represented
   * internally as an old-path tombstone plus a new-path skeleton/bodies.
   */
  async renameDocument(sourceDocPath: DocPath, destinationDocPath: DocPath): Promise<void> {
    await this.shadow.renameDocument(sourceDocPath, destinationDocPath);
  }

  // ─── Historical replay ────────────────────────────────────────────

  /**
   * Replay a document's exact historical state from a git commit into this
   * proposal's content tree — byte-for-byte, NO parsing, NO normalization, NO
   * round-tripping. Copies the historical skeleton file and `.sections/` tree
   * from `targetSha`, then validates assembly (every body file referenced by
   * the restored skeleton must exist). Returns the restored heading paths.
   *
   * Throws `DocumentAssemblyError` (from the engine) when the historical
   * commit is missing referenced section body files — the caller maps that to
   * a restore-validation failure.
   *
   * This logic was previously inlined in `restore-service.ts`; it lives here
   * so restore goes through the proposal facade.
   */
  async replayDocumentFromGitCommit(
    docPath: DocPath,
    targetSha: string,
  ): Promise<{ restoredHeadingPaths: string[][] }> {
    const dataRoot = getDataRoot();
    const gitPrefix = getContentGitPrefix();

    const contentRelativeFsPath = docPathToContentRelativeFsPath(DocPath.parse(docPath));
    const skeletonGitPath = `${gitPrefix}/${contentRelativeFsPath}`;
    const sectionsDirGitPrefix = `${gitPrefix}/${contentRelativeFsPath}.sections/`;

    // Copy skeleton file byte-for-byte from git.
    const skeletonContent = await gitShowFile(dataRoot, targetSha, skeletonGitPath);
    const proposalSkeletonPath = resolveSkeletonPath(docPath, this.contentRoot);
    await mkdir(path.dirname(proposalSkeletonPath), { recursive: true });
    await writeFile(proposalSkeletonPath, skeletonContent, "utf8");

    // Copy all section body files byte-for-byte from git.
    const proposalSectionsDir = proposalSkeletonPath + ".sections";
    await extractHistoricalTree(dataRoot, targetSha, sectionsDirGitPrefix, proposalSectionsDir);

    // Validate assembly against the freshly-written single-root content tree
    // (no canonical fallback — a replay must be self-contained). Throws
    // DocumentAssemblyError if any referenced body file is missing.
    const replayedLayer = new ContentLayer(this.contentRoot);
    await replayedLayer.readAllSections(docPath);

    const restoredHeadingPaths = await replayedLayer.listHeadingPaths(docPath);
    return { restoredHeadingPaths };
  }
}
