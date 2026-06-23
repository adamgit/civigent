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
 * brand-gated `updateProposalSections(...)`.
 *
 * Application and MCP callers MUST import THIS function, never `ProposalEditor`
 * plus a raw `updateProposalSections(...)` (enforced by the import-boundary test).
 */

import type { AnyProposal, ProposalSection, DocumentTargetRef } from "../types/shared.js";
import { documentTargetRef } from "../types/shared.js";
import type { ContentEntry, FlatEntry } from "./document-skeleton.js";
import type { ProposalWriteResult, ProposalSubtreeMutationResult } from "./proposal-facade-types.js";
import { ProposalEditor } from "./proposal-editor.js";
import { readProposal, updateProposalSections } from "./proposal-repository.js";
import { mintProposalManifest, unionSections, type ProposalManifest } from "./proposal-manifest.js";
import { sectionWriteInputFromExternal, type SectionBodyWithPotentialSubsections } from "./section-formatting.js";

/**
 * The semantic proposal-content operations. Callers pass the operation; this
 * module owns the filename / skeleton / manifest consequences. Each operation
 * maps to exactly one `ProposalEditor` mutation.
 */
export type ProposalContentOperation =
  | { kind: "write_section"; docPath: string; headingPath: string[]; heading: string; content: SectionBodyWithPotentialSubsections; contentIsFullMarkdown?: boolean; justification?: string }
  | { kind: "create_section"; docPath: string; headingPath: string[]; heading: string; content?: SectionBodyWithPotentialSubsections; justification?: string }
  | { kind: "delete_section"; docPath: string; headingPath: string[] }
  | { kind: "move_section"; docPath: string; headingPath: string[]; newParentPath: string[] }
  | { kind: "rename_section"; docPath: string; headingPath: string[]; newHeading: string }
  | { kind: "write_document_markdown"; files: Array<{ docPath: string; markdown: string }> }
  | { kind: "create_document"; docPath: string }
  | { kind: "delete_document"; docPath: string }
  | { kind: "rename_document"; docPath: string; newPath: string }
  | { kind: "replay_document"; docPath: string; targetSha: string; extraDeletedSections?: ProposalSection[] };

/**
 * Result of a `mutateProposalContent(...)` call. `proposal` and `manifest` are
 * always present; op-specific fields carry the mutation's detailed result for
 * callers that need it (e.g. live-fragment reconciliation, response shaping).
 */
export interface MutateProposalContentResult {
  /** The proposal with its freshly-updated `sections` manifest. */
  proposal: AnyProposal;
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

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

function sectionsUnder(docPath: string, headingPaths: string[][]): ProposalSection[] {
  return headingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp }));
}

function flatEntriesToSections(docPath: string, entries: Array<{ headingPath: string[] }>): ProposalSection[] {
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
): Promise<MutateProposalContentResult> {
  // Fresh disk read: locate the proposal and read its current (cumulative) claim
  // set. Never cached across calls.
  const proposal = await readProposal(proposalId);
  const editor = ProposalEditor.open(proposalId, proposal.status);
  const existing = proposal.sections;

  let affected: ProposalSection[];
  const extras: Omit<MutateProposalContentResult, "proposal" | "manifest"> = {};

  switch (operation.kind) {
    case "write_section":
    case "create_section": {
      const writeResult =
        operation.kind === "write_section"
          ? await editor.writeSection(operation.docPath, operation.headingPath, operation.heading, operation.content, {
              contentIsFullMarkdown: operation.contentIsFullMarkdown,
            })
          : await editor.createSection(operation.docPath, operation.headingPath, operation.heading, operation.content ?? sectionWriteInputFromExternal(""));
      extras.writeResult = writeResult;
      // Authoritative affected set: every parser-expanded section written, every
      // section removed by the restructure, and both sides of any structure change
      // — NOT just the requested heading path.
      const touched: FlatEntry[] = [
        ...writeResult.writtenEntries,
        ...writeResult.removedEntries,
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
      const removed = await editor.deleteSection(operation.docPath, operation.headingPath);
      affected = flatEntriesToSections(operation.docPath, removed);
      // Defensive: if the engine ever returns an empty set, still claim the target.
      if (affected.length === 0) affected = sectionsUnder(operation.docPath, [operation.headingPath]);
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
      const newLevel = operation.newParentPath.length === 0 ? current.level : operation.newParentPath.length + 1;
      // Authoritative affected set: both the removed (old) and added (new)
      // identities of the moved subtree, descendants included.
      const moveResult = await editor.moveSection(
        operation.docPath,
        operation.headingPath,
        operation.newParentPath,
        newLevel,
      );
      extras.moveResult = moveResult;
      affected = [
        ...flatEntriesToSections(operation.docPath, moveResult.removed),
        ...flatEntriesToSections(operation.docPath, moveResult.added),
      ];
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
      for (const file of operation.files) {
        await editor.writeDocumentFromMarkdown(file.docPath, file.markdown);
        const headingPaths = await editor.listHeadingPaths(file.docPath);
        affected.push(...sectionsUnder(file.docPath, headingPaths));
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
