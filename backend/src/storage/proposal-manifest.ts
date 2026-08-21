/**
 * Branded `ProposalManifest` — a proposal's authoritative claim set as a NOMINAL
 * type that application/MCP callers cannot construct.
 *
 * Spec basis: a proposal's claim set is the lock / policy / audit / event claim
 * set (spec 12 §Proposal FSM locking; spec 04 §Decisions and APIs), so it MUST be
 * derived from the authoritative storage-mutation result or a fresh proposal disk
 * readback — never hand-built from request parameters. This brand makes that a
 * COMPILE-TIME guarantee: `updateProposalSections(...)` accepts only a
 * `ProposalManifest`, and the only legitimate producers of the brand are:
 *   - `mutateProposalContent(...)` (the disk-operation boundary), and
 *   - `unsafeReplaceProposalManifestForRecoveryOnly(...)` (the narrowly-justified
 *     recovery / bootstrap / CRDT-internal escape hatch).
 *
 * A manifest carries TWO views (spec 12 §Data Shapes):
 *   - `sections` — the section content/evaluation view (with `justification`).
 *   - `targets`  — the authoritative lock/audit/policy claim set, INCLUDING
 *                  document targets for document create/delete/rename. The section
 *                  subset of `targets` mirrors `sections`.
 *
 * Do NOT import `mintProposalManifest` from application or MCP code — see the
 * import-boundary test that enforces this.
 */

import type { DeletedSectionFileRef, ProposalSectionClaim, ProposalTargetRef } from "../types/shared.js";
import { asSectionTarget, proposalTargetKey } from "../types/shared.js";

declare const PROPOSAL_MANIFEST_BRAND: unique symbol;

/**
 * A proposal claim set derived by an authorized manifest-owning path. The brand
 * prevents construction from raw arrays at any application/MCP call site.
 */
export interface ProposalManifest {
  readonly [PROPOSAL_MANIFEST_BRAND]: true;
  /** Section content/evaluation view (with justification). */
  readonly sections: ProposalSectionClaim[];
  /** Authoritative lock/audit/policy claim set (section + document targets). */
  readonly targets: ProposalTargetRef[];
}

/**
 * Mint a `ProposalManifest` from raw sections (+ optional extra document/section
 * targets). INTERNAL — only the `mutateProposalContent(...)` boundary and the
 * explicit recovery escape hatch may call this. The runtime is a transparent
 * construction; the safety is entirely at the type level (the import-boundary
 * test polices who may call it).
 *
 * `targets` defaults to the section targets derived from `sections`; pass
 * `extraTargets` to add document targets (or any non-section claims).
 */
export function mintProposalManifest(
  sections: ProposalSectionClaim[],
  extraTargets: ProposalTargetRef[] = [],
): ProposalManifest {
  const targets = dedupeTargets([...sections.map(asSectionTarget), ...extraTargets]);
  return { sections, targets } as ProposalManifest;
}

/**
 * Union two section sets, de-duplicating by `doc_path` + `heading_path`. Used by
 * the boundary to merge an operation's affected sections into the proposal's
 * existing cumulative claim set (a proposal may carry several mutations before
 * commit). Keeps the first-seen `justification` for a duplicate.
 */
export function unionSections(
  existing: ProposalSectionClaim[],
  affected: ProposalSectionClaim[],
): ProposalSectionClaim[] {
  const byKey = new Map<string, ProposalSectionClaim>();
  const keyOf = (s: ProposalSectionClaim): string => `${s.doc_path} ${JSON.stringify(s.heading_path)}`;
  for (const s of existing) byKey.set(keyOf(s), s);
  for (const s of affected) {
    const k = keyOf(s);
    if (!byKey.has(k)) byKey.set(k, s);
  }
  return [...byKey.values()];
}

/**
 * Union two deleted-section-file id sets, de-duplicating by `doc_path` +
 * `section_file` (identity-based delete detection). The deleted-id set is
 * grow-only — once a proposal records a canonical section-file id as deleted it
 * never drops it — so this only ever appends new ids. Used by the storage
 * boundary's `recordDeletedSectionFiles` append path.
 */
export function unionDeletedSectionFiles(
  existing: DeletedSectionFileRef[],
  added: DeletedSectionFileRef[],
): DeletedSectionFileRef[] {
  const byKey = new Map<string, DeletedSectionFileRef>();
  const keyOf = (d: DeletedSectionFileRef): string => JSON.stringify([d.doc_path, d.section_file]);
  for (const d of existing) byKey.set(keyOf(d), d);
  for (const d of added) {
    const k = keyOf(d);
    if (!byKey.has(k)) byKey.set(k, d);
  }
  return [...byKey.values()];
}

/** De-duplicate a target list by stable target key, keeping first-seen. */
export function dedupeTargets(targets: ProposalTargetRef[]): ProposalTargetRef[] {
  const byKey = new Map<string, ProposalTargetRef>();
  for (const t of targets) {
    const k = proposalTargetKey(t);
    if (!byKey.has(k)) byKey.set(k, t);
  }
  return [...byKey.values()];
}

/** Union two target sets, de-duplicating by stable target key. */
export function unionTargets(
  existing: ProposalTargetRef[],
  affected: ProposalTargetRef[],
): ProposalTargetRef[] {
  return dedupeTargets([...existing, ...affected]);
}
