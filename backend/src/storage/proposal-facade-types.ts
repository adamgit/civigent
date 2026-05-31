/**
 * Proposal facade types — the public capability surface shared by
 * `ProposalReader` (non-mutating) and `ProposalEditor` (read/write).
 *
 * These facades expose a proposal content tree through `DocumentSkeleton`
 * while hiding the proposal-internal storage layout (skeleton / body /
 * `.tombstone` files). NONE of the exported types here may leak storage
 * paths — callers (REST routes, MCP tools, CRDTProposalGenerator) work in
 * terms of doc paths, heading paths, and effective states only.
 *
 * Spec source of truth: `01-data-primitives.md` ("ProposalReader /
 * ProposalEditor API surface") and `04-decisions-and-apis.md"
 * ("Auto-creation within ProposalEditor", "Tombstone-file pattern").
 */

import type { SectionBody } from "./section-formatting.js";
import type { UpsertSectionFromMarkdownDetailedResult } from "./content-layer.js";
import type { FlatEntry } from "./document-skeleton.js";

/**
 * Effective state of a document inside a proposal content tree, resolved
 * tombstone-first then live then missing. A proposal may shadow a canonical
 * document as pending-deletion ("tombstone"), present its own or canonical
 * structure ("live"), or have no view of it at all ("missing").
 *
 * This is structurally the same union as the storage-layer
 * `OverlayDocumentState`, re-exported here so facade callers never import
 * from the storage engine module.
 */
export type ProposalDocumentState = "tombstone" | "live" | "missing";

/**
 * Result of a section read through a facade: the effective body content at a
 * heading path. `null` body means the section does not exist in the effective
 * proposal view (caller decides whether that is an error).
 */
export interface ProposalSectionReadResult {
  readonly docPath: string;
  readonly headingPath: string[];
  readonly body: SectionBody;
}

/**
 * Detailed result of a content write / replace through `ProposalEditor`.
 *
 * This re-exposes the storage engine's detailed remap/result shape
 * (written / removed entries, fragment-key remaps, live-reload entries,
 * structure changes) so callers that need to reconcile derived state (e.g.
 * live CRDT fragments) keep the same information they had when calling the
 * shadow layer directly — without importing the engine type by its
 * storage-layer name.
 */
export type ProposalWriteResult = UpsertSectionFromMarkdownDetailedResult;

/**
 * Result of a structural subtree mutation (move) through `ProposalEditor`.
 * Carries the removed and added flat entries so callers can update derived
 * section manifests / live fragments.
 */
export interface ProposalSubtreeMutationResult {
  readonly removed: FlatEntry[];
  readonly added: FlatEntry[];
}
