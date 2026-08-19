/**
 * `mutateProposalContent(...)` — the single disk-operation boundary that owns
 * derivation of a proposal's `sections` manifest from an authoritative storage
 * mutation.
 *
 * Spec basis: `DocumentSkeleton` remains the source of section identity/structure;
 * proposal content-tree writes hide proposal-internal storage details and preserve
 * parser-driven structural expansion (spec 01 §Data primitives; spec 04 §Decisions
 * and APIs). The proposal `sections` manifest is the lock / policy / audit / event
 * claim set (spec 12 §Proposal FSM locking), so it MUST be derived from the real
 * mutation result (removed/added/written entries, parser-expanded sections,
 * descendants) or a fresh disk readback — NEVER guessed from request parameters.
 *
 * This boundary is NOT a long-lived `.open(...)` object and caches nothing as a
 * source of truth: each call reads/locates the proposal on disk, opens a
 * short-lived `ProposalEditor`, applies EXACTLY ONE semantic mutation, derives the
 * affected manifest from that mutation's authoritative result, unions it into the
 * proposal's existing cumulative claim set, and updates `meta.json` via the
 * brand-gated `updateProposalSections(...)`. `reorder_section` is one such
 * semantic mutation: exactly one `reorderSection` call.
 *
 * Application and MCP callers MUST import THIS function, never `ProposalEditor`
 * plus a raw `updateProposalSections(...)` (enforced by the import-boundary test).
 */

import type { ActiveProposal, ProposalSection, DocumentTargetRef, LiveMovePosition } from "../types/shared.js";
import { documentTargetRef, HeadingLevel } from "../types/shared.js";
import type { ContentEntry, FlatEntry } from "./document-skeleton.js";
import type { ProposalWriteResult, ProposalSubtreeMutationResult } from "./proposal-facade-types.js";
import { ProposalEditor } from "./proposal-editor.js";
import { readActiveProposal, updateProposalSections } from "./proposal-repository.js";
import { mintProposalManifest, unionSections, type ProposalManifest } from "./proposal-manifest.js";
import { sectionWriteInputFromExternal, type SectionBodyWithPotentialSubsections } from "./section-formatting.js";
import type { DocPath } from "../types/shared.js";

/**
 * The semantic proposal-content operations. Callers pass the operation; this
 * module owns the filename / skeleton / manifest consequences. Each operation
 * maps to exactly one `ProposalEditor` mutation.
 */
export type ProposalContentOperation =
  | { kind: "write_section"; docPath: DocPath; headingPath: string[]; heading: string; content: SectionBodyWithPotentialSubsections; expandHeadingsIntoSections?: boolean; justification?: string }
  | { kind: "create_section"; docPath: DocPath; headingPath: string[]; heading: string; content?: SectionBodyWithPotentialSubsections; beforeHeadingPath?: string[]; afterHeadingPath?: string[]; justification?: string }
  | { kind: "delete_section"; docPath: DocPath; headingPath: string[] }
  | { kind: "move_section"; docPath: DocPath; headingPath: string[]; newParentPath: string[] }
  | { kind: "reorder_section"; docPath: DocPath; headingPath: string[]; targetHeadingPath: string[]; position: LiveMovePosition }
  | { kind: "rename_section"; docPath: DocPath; headingPath: string[]; newHeading: string }
  | { kind: "write_document_markdown"; files: Array<{ docPath: DocPath; markdown: string }> }
  | { kind: "create_document"; docPath: DocPath }
  | { kind: "delete_document"; docPath: DocPath }
  | { kind: "rename_document"; docPath: DocPath; newPath: DocPath }
  | { kind: "replay_document"; docPath: DocPath; targetSha: string; extraDeletedSections?: ProposalSection[] };

/**
 * Result of a `mutateProposalContent(...)` call. `proposal` and `manifest` are
 * always present; op-specific fields carry the mutation's detailed result for
 * callers that need it (e.g. live-fragment reconciliation, response shaping).
 */
export interface MutateProposalContentResult {
  /** The proposal with its freshly-updated `sections` manifest. */
  proposal: ActiveProposal;
  /** The derived, brand-stamped manifest written to `meta.json`. */
  manifest: ProposalManifest;
  /** write_section / create_section: the engine's detailed write result. */
  writeResult?: ProposalWriteResult;
  /** move_section: removed + added flat entries. */
  moveResult?: ProposalSubtreeMutationResult;
  /** rename_section: the renamed content entry + the new heading path. */
  renamedEntry?: ContentEntry;
  newHeadingPath?: string[];
  /** delete_document / rename_document / replay_document: affected heading paths. */
  documentHeadingPaths?: string[][];
}

/** Thrown when a `move_section` target is not present in the proposal's effective
 *  section list. Callers map this to a 404 / tool-error with prose. */
export class ProposalSectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalSectionNotFoundError";
  }
}

export class ProposalSectionReorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalSectionReorderError";
  }
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * The proposal-scoped twin of the live-move sibling/BFH precheck
 * (`crdt-ws-coordinator.ts` reorder path): validate a sibling-placement request
 * against the proposal's effective section list before touching the engine.
 * `reorderSiblingSection` still throws if a caller skips it, but MCP/mutate
 * must not surface those throws as 500s.
 */
function checkSiblingReorder(
  docPath: DocPath,
  headingPath: string[],
  targetHeadingPath: string[],
  rows: Array<{ headingPath: string[] }>,
): void {
  if (headingPath.length === 0) {
    throw new ProposalSectionReorderError("Cannot reorder the before-first-heading section.");
  }
  if (targetHeadingPath.length === 0) {
    throw new ProposalSectionReorderError("Cannot reorder relative to the before-first-heading section.");
  }
  if (!rows.some((e) => samePath(e.headingPath, headingPath))) {
    throw new ProposalSectionNotFoundError(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
  }
  if (!rows.some((e) => samePath(e.headingPath, targetHeadingPath))) {
    throw new ProposalSectionNotFoundError(`Section not found: ${targetHeadingPath.join(" > ")} in ${docPath}`);
  }
  const parentPath = headingPath.slice(0, -1);
  const targetParentPath = targetHeadingPath.slice(0, -1);
  if (!samePath(parentPath, targetParentPath)) {
    throw new ProposalSectionReorderError("Sections can only be reordered among siblings that share the same parent.");
  }
}

function sectionsUnder(docPath: DocPath, headingPaths: string[][]): ProposalSection[] {
  return headingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp }));
}

function flatEntriesToSections(docPath: DocPath, entries: Array<{ headingPath: string[] }>): ProposalSection[] {
  return entries.map((e) => ({ doc_path: docPath, heading_path: e.headingPath }));
}

/**
 * Apply exactly one proposal-content mutation and derive the resulting manifest
 * from its authoritative result. The proposal must be in a mutable status
 * (`draft` | `pending` | `inprogress`); `updateProposalSections` enforces this.
 */
export async function mutateProposalContent(
  proposalId: string,
  operation: ProposalContentOperation,
  options?: { onDocumentWritten?: (progress: { index: number; total: number; docPath: DocPath }) => void },
): Promise<MutateProposalContentResult> {
  // Fresh disk read: locate the proposal and read its current (cumulative) claim
  // set. Never cached across calls.
  const proposal = await readActiveProposal(proposalId);
  const editor = ProposalEditor.open(proposalId, proposal.status);
  const existing = proposal.sections;

  let affected: ProposalSection[];
  const extras: Omit<MutateProposalContentResult, "proposal" | "manifest"> = {};

  switch (operation.kind) {
    case "write_section":
    case "create_section": {
      if (
        operation.kind === "create_section" &&
        operation.beforeHeadingPath !== undefined &&
        operation.afterHeadingPath !== undefined
      ) {
        throw new ProposalSectionReorderError("Provide at most one of before_heading_path and after_heading_path.");
      }
      const writeResult =
        operation.kind === "write_section"
          ? await editor.writeSection(operation.docPath, operation.headingPath, operation.heading, operation.content, {
              expandHeadingsIntoSections: operation.expandHeadingsIntoSections,
            })
          : await editor.createSection(operation.docPath, operation.headingPath, operation.heading, operation.content ?? sectionWriteInputFromExternal(""));
      extras.writeResult = writeResult;
      // Create-at-position is still one semantic mutate call: the engine create
      // stays append-only and placement is the existing reorder primitive on the
      // requested leaf only (parser-expanded descendants are not reordered;
      // auto-created ancestors stay where `materializeAncestorHeadings` pushed
      // them). If the heading already existed, the upsert still runs and the
      // reorder still moves that leaf — placement is "put this heading here,"
      // not "only if newly inserted."
      if (operation.kind === "create_section") {
        const anchor = operation.beforeHeadingPath ?? operation.afterHeadingPath;
        if (anchor !== undefined) {
          checkSiblingReorder(operation.docPath, operation.headingPath, anchor, await editor.getSectionList(operation.docPath));
          await editor.reorderSection(
            operation.docPath,
            operation.headingPath,
            anchor,
            operation.beforeHeadingPath !== undefined ? "before" : "after",
          );
        }
      }
      // Authoritative affected set: every parser-expanded section written, every
      // section removed by the restructure, and both sides of any structure change
      // — NOT just the requested heading path.
      const touched: FlatEntry[] = [
        ...writeResult.writtenEntries,
        ...writeResult.removedContentEntries,
        ...writeResult.structureChanges.flatMap((c) => [c.oldEntry, ...c.newEntries]),
      ];
      affected = flatEntriesToSections(operation.docPath, touched);
      // Carry the caller's per-section justification onto the PRIMARY written
      // section (the requested heading). Justification drives the agent-write
      // policy bypass (spec 12), so it must survive manifest derivation; the
      // parser-expanded descendants are newly-created and carry none.
      if (operation.justification !== undefined) {
        const primary = affected.find((s) => samePath(s.heading_path, operation.headingPath));
        if (primary) primary.justification = operation.justification;
        else affected.push({ doc_path: operation.docPath, heading_path: operation.headingPath, justification: operation.justification });
      }
      break;
    }
    case "delete_section": {
      // Authoritative affected set: the target section PLUS every deleted
      // descendant (the engine returns the full removed subtree).
      const removed = await editor.deleteSubtree(operation.docPath, operation.headingPath);
      affected = flatEntriesToSections(operation.docPath, removed);
      // Defensive: if the engine ever returns an empty set, still claim the target.
      if (affected.length === 0) affected = sectionsUnder(operation.docPath, [operation.headingPath]);
      // Identity-based delete detection (D3/D4): the delete is recorded inside
      // `editor.deleteSubtree` as the removed canonical section-file IDS in the
      // proposal's `deleted_section_files` set — that id set is the signal the
      // effective-structure merge and the absorb use to drop the section (by id, so
      // it survives ancestor rename/move). `unionSections` below still KEEPS the
      // deleted heading path in `sections` for lock/audit (the manifest is grow-only).
      break;
    }
    case "move_section": {
      // Resolve the new level from the effective section list (boundary-owned, so
      // callers never open an editor): keep the section's level when moving to
      // root, else nest one below the new parent.
      const current = (await editor.getSectionList(operation.docPath)).find((e) =>
        samePath(e.headingPath, operation.headingPath),
      );
      if (!current) {
        throw new ProposalSectionNotFoundError(
          `Section not found: ${operation.headingPath.join(" > ")} in ${operation.docPath}`,
        );
      }
      const newHeadingLevel = operation.newParentPath.length === 0
        ? current.headingLevel
        : HeadingLevel.parse(operation.newParentPath.length + 1);
      // Authoritative affected set: both the removed (old) and added (new)
      // identities of the moved subtree, descendants included.
      const moveResult = await editor.moveSection(
        operation.docPath,
        operation.headingPath,
        operation.newParentPath,
        newHeadingLevel,
      );
      extras.moveResult = moveResult;
      affected = [
        ...flatEntriesToSections(operation.docPath, moveResult.removed),
        ...flatEntriesToSections(operation.docPath, moveResult.added),
      ];
      break;
    }
    case "reorder_section": {
      checkSiblingReorder(
        operation.docPath,
        operation.headingPath,
        operation.targetHeadingPath,
        await editor.getSectionList(operation.docPath),
      );
      await editor.reorderSection(operation.docPath, operation.headingPath, operation.targetHeadingPath, operation.position);
      affected = sectionsUnder(operation.docPath, [operation.headingPath, operation.targetHeadingPath]);
      break;
    }
    case "rename_section": {
      // A rename changes the heading-path segment for the target AND every
      // descendant. Capture the old subtree before, the new subtree after, and
      // claim both — so the manifest records the old removed identities and the
      // new added identities (descendants included).
      const before = await editor.getSectionList(operation.docPath);
      const oldSubtree = before
        .filter((e) => isPrefix(operation.headingPath, e.headingPath))
        .map((e) => e.headingPath);

      const renamedEntry = await editor.renameSection(operation.docPath, operation.headingPath, operation.newHeading);
      const newHeadingPath = [...operation.headingPath.slice(0, -1), operation.newHeading];
      extras.renamedEntry = renamedEntry;
      extras.newHeadingPath = newHeadingPath;

      const after = await editor.getSectionList(operation.docPath);
      const newSubtree = after
        .filter((e) => isPrefix(newHeadingPath, e.headingPath))
        .map((e) => e.headingPath);

      affected = sectionsUnder(operation.docPath, [...oldSubtree, ...newSubtree]);
      break;
    }
    case "write_document_markdown": {
      // Whole-document (re)write: derive each doc's claim set from a fresh disk
      // readback of the normalized heading structure AFTER the parser-driven write.
      affected = [];
      for (const [fileIndex, file] of operation.files.entries()) {
        await editor.writeDocumentFromMarkdown(file.docPath, file.markdown);
        const headingPaths = await editor.listHeadingPaths(file.docPath);
        affected.push(...sectionsUnder(file.docPath, headingPaths));
        options?.onDocumentWritten?.({ index: fileIndex + 1, total: operation.files.length, docPath: file.docPath });
      }
      break;
    }
    case "create_document": {
      await editor.createDocument(operation.docPath);
      // A fresh empty document declares no sections yet.
      affected = [];
      break;
    }
    case "delete_document": {
      // Authoritative affected set: the canonical heading paths going away.
      const headingPaths = await editor.deleteDocument(operation.docPath);
      extras.documentHeadingPaths = headingPaths;
      affected = sectionsUnder(operation.docPath, headingPaths);
      break;
    }
    case "rename_document": {
      // Snapshot the source heading paths BEFORE the rename, then claim both the
      // tombstoned old-path sections and the created new-path sections.
      const headingPaths = await editor.listHeadingPaths(operation.docPath);
      await editor.renameDocument(operation.docPath, operation.newPath);
      extras.documentHeadingPaths = headingPaths;
      affected = [
        ...sectionsUnder(operation.docPath, headingPaths),
        ...sectionsUnder(operation.newPath, headingPaths),
      ];
      break;
    }
    case "replay_document": {
      // Restore: byte-for-byte historical replay. Claim the restored sections plus
      // any caller-supplied deleted sections (sections present in canonical but not
      // in the restored snapshot, which the restore removes).
      const { restoredHeadingPaths } = await editor.replayDocumentFromGitCommit(operation.docPath, operation.targetSha);
      extras.documentHeadingPaths = restoredHeadingPaths;
      affected = [
        ...sectionsUnder(operation.docPath, restoredHeadingPaths),
        ...(operation.extraDeletedSections ?? []),
      ];
      break;
    }
  }

  // Section content/evaluation view: cumulative union of section claims.
  const sections = unionSections(existing, affected);
  // Authoritative claim set: re-derived section targets (from `sections`) PLUS
  // any document targets — both the ones this operation claims and any the
  // proposal already accumulated (a proposal may carry several document ops).
  const existingDocumentTargets = proposal.targets.filter(
    (t): t is DocumentTargetRef => t.kind === "document",
  );
  const documentTargets = [...existingDocumentTargets, ...documentTargetsForOperation(operation)];
  const manifest = mintProposalManifest(sections, documentTargets);
  const { proposal: updated } = await updateProposalSections(proposalId, manifest);

  return { proposal: updated, manifest, ...extras };
}

/**
 * Document-path claims an operation makes (spec 12 / spec 04). Section-level
 * operations claim none — their section targets are derived from `sections`.
 * Document create/delete claim the document path; rename claims old + new;
 * whole-document writes (import/overwrite) and restore replay claim the written
 * document path so a live-empty document still holds a target.
 */
function documentTargetsForOperation(operation: ProposalContentOperation): DocumentTargetRef[] {
  switch (operation.kind) {
    case "create_document":
    case "delete_document":
      return [documentTargetRef(operation.docPath)];
    case "rename_document":
      return [documentTargetRef(operation.docPath), documentTargetRef(operation.newPath)];
    case "replay_document":
      return [documentTargetRef(operation.docPath)];
    case "write_document_markdown":
      return operation.files.map((f) => documentTargetRef(f.docPath));
    default:
      return [];
  }
}

/** True when `prefix` is a (non-strict) prefix of `path` — i.e. `path` is the
 *  target itself or one of its descendants. */
function isPrefix(prefix: string[], path: string[]): boolean {
  if (path.length < prefix.length) return false;
  return prefix.every((seg, i) => path[i] === seg);
}
