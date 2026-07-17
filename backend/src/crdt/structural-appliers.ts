/**
 * Identity-preserving live structural appliers (WS-2).
 *
 * These replace the layout set-diff (`computeLiveStructuralReconcile`) for the
 * structural cases the classifier (`structural-change.ts`) detects. The defining
 * property — and the whole point of the rebuild — is that a SURVIVING section's
 * existing Y.XmlFragment children keep their Yjs struct IDs, so every editor's
 * `RelativePosition` (cursor) still resolves after the mutation.
 *
 * The trap the plan calls out: `LiveFragmentStringsStore.replaceFragmentString`
 * deletes every child then `Y.applyUpdate`s a fresh temp-doc — correct markdown,
 * but it re-mints every struct (identity violation). It is therefore used ONLY to
 * seed GENUINELY-NEW fragments here, never to rewrite a survivor.
 *
 * The survivor is mutated with INDEX-BASED `Y.XmlFragment.delete(idx, n)`: Yjs
 * `delete` only tombstones the removed items, so the items that remain keep their
 * ids. A split keeps the surviving prefix/body and deletes the moved-out trailing
 * nodes (and, when the survivor becomes a body-holder, the leading heading node).
 *
 * Compute runs OUTSIDE the generator's `Y.transact` (against a snapshot); apply
 * runs INSIDE it, guarded by the pre-flight clock check.
 */

import * as Y from "yjs";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { buildFragmentContent, EMPTY_BODY, appendToBody, appendBodyToFragment, bodyFromFragmentStrippingLeadingHeading, sectionWriteInputFromBody, type FragmentContent, type SectionBody } from "../storage/section-formatting.js";
import { SectionRef } from "../domain/section-ref.js";
import { resolveLiveSectionLayout, readLiveSectionBodies, type LiveSectionLayoutEntry } from "./live-section-layout.js";
import { BEFORE_FIRST_HEADING_KEY, getBackendSchema } from "./ydoc-fragments.js";
import type { LiveFragmentStringsStore } from "./live-fragment-strings-store.js";
import type { StructuralChange } from "./structural-change.js";
import type { ProposalId, ProposalSection } from "../types/shared.js";
import type { UpsertSectionFromMarkdownDetailedResult } from "../storage/content-layer.js";
import type { FlatEntry } from "../storage/document-skeleton.js";

/**
 * Build the manifest add/remove for a write result, MIRRORING the per-edit
 * `growProposalManifest` (C4) delta→manifest shape: ADD the body-bearing
 * written-entry heading paths (sub-skeleton parents carry no body claim), DROP
 * the removed-entry heading paths. Used by the quiescence reflections to keep the
 * `inprogress` proposal's section CLAIM in sync with the structural promotion /
 * fold they apply to proposal CONTENT — without a full proposal re-derive (which
 * would over-claim unedited inherited sections).
 */
function manifestDeltaFromResult(
  docPath: string,
  result: UpsertSectionFromMarkdownDetailedResult,
): { add: ProposalSection[]; remove: ProposalSection[] } {
  const add = result.writtenEntries
    .filter((e) => !e.isSubSkeleton)
    .map((e) => ({ doc_path: docPath, heading_path: [...e.headingPath] }));
  const remove = result.removedContentEntries.map((e) => ({ doc_path: docPath, heading_path: [...e.headingPath] }));
  return { add, remove };
}

/**
 * Identity-preserving "set this live fragment's content to `targetMarkdown`"
 * primitive. Uses y-prosemirror's `updateYFragment` (a real minimal prefix/suffix
 * diff), so nodes shared between the current content and the target keep their
 * Yjs struct ids. This is the ONLY identity-preserving full-content set — it is
 * NOT `LiveFragmentStringsStore.replaceFragmentString` (delete-all + re-apply,
 * which re-mints). Must run inside a `Y.transact`.
 *
 * Note the prefix/suffix limitation: a node that survives only in the MIDDLE
 * (e.g. a body kept while a leading heading is removed) is NOT matched and gets
 * re-minted — those cases use targeted index deletes instead (see the split
 * applier). For append-only edits (merge onto a predecessor) and edit-heading-
 * in-place edits (rename/level-change), prefix matching preserves the shared
 * nodes, which is exactly what is required.
 */
export function updateFragmentPreservingIdentity(
  ydoc: Y.Doc,
  fragmentKey: string,
  targetMarkdown: FragmentContent,
): void {
  const frag = ydoc.getXmlFragment(fragmentKey);
  const targetNode = getBackendSchema().nodeFromJSON(markdownToJSON(targetMarkdown));
  updateYFragment(ydoc, frag, targetNode, { mapping: new Map(), isOMark: new Map() });
}

/**
 * A precomputed identity-preserving split: mutate the survivor fragment in place
 * (delete the moved-out trailing nodes) and seed each genuinely-new fragment.
 * Under Option A every live fragment carries its heading — including a survivor
 * that becomes a sub-skeleton parent — so there is no leading-heading strip.
 */
export interface StructuralSplitPlan {
  survivorKey: string;
  /** Delete survivor children from this index to the end (the moved-out content). */
  deleteFrom: number;
  /** New fragment key → its full content, seeded fresh (no prior identity). */
  seeds: Map<string, FragmentContent>;
  /** Fragment keys this plan touches, for the generator's pre-flight clock check. */
  affectedKeys: string[];
  /**
   * Bootstrap BFH dissolve on empty-preamble root-split. When the survivor is
   * the before-first-heading fragment AND the surviving `rootBody` is empty/
   * whitespace, the applier unregisters the BFH live fragment key after clearing
   * its children so it leaves the effective layout. The coordinator additionally
   * removes BFH from the proposal skeleton (`deleteSection([])`) and emits
   * `section:gone` for BFH — same client contract as heading-deletion merge.
   * A non-empty preamble keeps BFH as the survivor section (unchanged root-split).
   */
  dissolveSurvivorBfh?: boolean;
}

const HEADING_NODE = "heading";

/** Count of leading top-level heading nodes among a fragment's children. */
function isHeadingNode(node: unknown): boolean {
  return node instanceof Y.XmlElement && node.nodeName === HEADING_NODE;
}

/**
 * Find the child index of the Nth (1-based) top-level heading node in a live
 * Y.XmlFragment, or the fragment length if there are fewer than N headings.
 */
function indexOfNthHeading(ydoc: Y.Doc, fragmentKey: string, n: number): number {
  const frag = ydoc.getXmlFragment(fragmentKey);
  let seen = 0;
  for (let i = 0; i < frag.length; i++) {
    if (isHeadingNode(frag.get(i))) {
      seen += 1;
      if (seen === n) return i;
    }
  }
  return frag.length;
}

/**
 * Compute the identity-preserving split plan for a `root-split` / `section-split`
 * classified change. Runs OUTSIDE the transaction.
 *
 * PRECONDITION: the proposal layout has ALREADY been split for this change by
 * `reflectSplitIntoProposal(...)` (the quiescence-time reflection). Per-edit
 * materialization is topology-neutral and never splits the proposal, so this
 * plan reads the post-reflection layout to derive the live reshape.
 *
 *  - The survivor is the dirty fragment itself (its key is preserved by WS-0's
 *    survivor id-reuse, so the live key already matches the proposal layout).
 *  - The moved-out content is everything from the first NEW heading onward:
 *      • section-split: from the SECOND heading (the first heading is the
 *        survivor's own heading);
 *      • root-split: from the FIRST heading (the root/BFH survivor has no heading).
 *  - The survivor ALWAYS keeps its own heading line (Option A: every live fragment
 *    carries its heading, including a survivor that becomes a sub-skeleton parent —
 *    its body-holder layout entry now reports the parent's visible heading/level,
 *    and `snapshotSections` strips that heading at the parent level on re-snapshot).
 *  - New sections are whatever layout keys are absent from the live set; each is
 *    seeded from the proposal body at its authoritative heading/level.
 *
 * Returns null when there is nothing to add (the proposal layout introduced no
 * new fragment key — defensive; the classifier already gated on realSections).
 */
export async function computeStructuralSplitPlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  docPath: string,
  currentProposalId: ProposalId | null,
  dirtyKey: string,
  change: Extract<StructuralChange, { kind: "root-split" | "section-split" }>,
): Promise<StructuralSplitPlan | null> {
  const layout = await resolveLiveSectionLayout(docPath, currentProposalId);
  const liveKeys = new Set(liveFragments.getFragmentKeys());
  const addedEntries = layout.filter((e) => !liveKeys.has(e.fragmentKey));
  if (addedEntries.length === 0) return null;

  // Moved-out boundary: the first NEW heading. root-split → 1st heading;
  // section-split → 2nd heading (the survivor owns the 1st).
  const headingOrdinal = change.kind === "root-split" ? 1 : 2;
  const deleteFrom = indexOfNthHeading(ydoc, dirtyKey, headingOrdinal);

  // Seed each new fragment from the current proposal's effective body at its
  // authoritative shape — through the proposal-bound reader for the current
  // `inprogress` proposal, or a canonical-only read when there is no proposal.
  const bulkContent = await readLiveSectionBodies(docPath, currentProposalId);

  const seeds = new Map<string, FragmentContent>();
  for (const entry of addedEntries) {
    const body = bulkContent?.get(SectionRef.headingKey(entry.headingPath)) ?? EMPTY_BODY;
    seeds.set(entry.fragmentKey, buildFragmentContent(body, entry.level, entry.heading));
  }

  // Bootstrap BFH dissolve: an empty-doc BFH that just got its first heading
  // typed inside has no preamble content to keep as a section — treat that
  // survivor as a bootstrap mount target rather than a durable section (spec
  // 14 empty-doc BFH rule). A non-empty preamble keeps BFH via the normal
  // identity-preserving split path.
  const dissolveSurvivorBfh =
    change.kind === "root-split" &&
    dirtyKey === BEFORE_FIRST_HEADING_KEY &&
    change.rootBody.trim() === "";

  return {
    survivorKey: dirtyKey,
    deleteFrom,
    seeds,
    affectedKeys: [dirtyKey, ...addedEntries.map((e) => e.fragmentKey)],
    ...(dissolveSurvivorBfh ? { dissolveSurvivorBfh: true } : {}),
  };
}

/**
 * Apply a precomputed split plan INSIDE the generator's `Y.transact`. The
 * survivor's surviving children keep their struct ids; only the moved-out
 * trailing nodes are tombstoned (the survivor keeps its own heading — Option A).
 * New fragments are seeded fresh.
 */
export function applyStructuralSplitPlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  plan: StructuralSplitPlan,
  origin: unknown,
): void {
  const frag = ydoc.getXmlFragment(plan.survivorKey);
  // Delete the moved-out trailing nodes (the survivor keeps its heading + body).
  if (plan.deleteFrom < frag.length) {
    frag.delete(plan.deleteFrom, frag.length - plan.deleteFrom);
  }
  // Seed genuinely-new fragments (identity does not matter — they are new).
  for (const [key, content] of plan.seeds) {
    liveFragments.replaceFragmentString(key, content, origin);
  }
  // Bootstrap BFH dissolve: unregister the emptied BFH so `getFragmentKeys()`
  // stops listing it. Y.js cannot remove the top-level XmlFragment from
  // `ydoc.share`; the canvas render guard + block-state gone signal keep the
  // browser from touching the cleared-but-still-in-`share` key.
  if (plan.dissolveSurvivorBfh) {
    liveFragments.unregisterFragmentKey(plan.survivorKey);
  }
}

// ─── MERGE (heading-deletion → predecessor) ───────────────────────

/**
 * A precomputed identity-preserving merge: the dirty fragment lost its heading,
 * so its orphan body folds onto the END of the preceding section's fragment
 * (the predecessor's existing nodes keep their ids — append-only), and the dirty
 * fragment is removed.
 */
export interface StructuralMergePlan {
  predecessorKey: string;
  /** Predecessor's full target content (its current content + the orphan body). */
  predecessorTarget: FragmentContent;
  /** Authoritative identity of the predecessor (for proposal reflection). */
  predecessorIdentity: { headingPath: string[]; heading: string; level: number };
  /** The fragment to remove (the heading-deleted section). */
  removeKey: string;
  /** Heading path of the removed section (for proposal `deleteSection`). */
  removedHeadingPath: string[];
  /** The orphan body folded into the predecessor (for proposal reflection). */
  orphanBody: SectionBody;
  affectedKeys: string[];
}

/**
 * Compute the merge plan for a `heading-deletion` classified change. Runs OUTSIDE
 * the transaction. Returns null when there is no preceding section to merge into
 * (the dirty fragment is the document's first section — leave it for the set-diff
 * / future BFH handling rather than dropping content).
 */
export async function computeStructuralMergePlan(
  liveFragments: LiveFragmentStringsStore,
  docPath: string,
  currentProposalId: ProposalId | null,
  dirtyKey: string,
  change: Extract<StructuralChange, { kind: "heading-deletion" }>,
): Promise<StructuralMergePlan | null> {
  // Resolve doc order from the EFFECTIVE pre-normalization layout (canonical +
  // inprogress proposal manifest overlay): the predecessor is the section
  // immediately before the dirty one in document order — including sections
  // this session already promoted (proposal-only) that a canonical-only lookup
  // would miss and mis-attribute the merge to the wrong predecessor.
  const effectiveLayout: LiveSectionLayoutEntry[] = await resolveLiveSectionLayout(docPath, currentProposalId);
  const idx = effectiveLayout.findIndex((e) => e.fragmentKey === dirtyKey);
  if (idx <= 0) return null; // no predecessor in document order
  const predecessor = effectiveLayout[idx - 1];

  const orphanBody = change.orphanedBody;
  const predecessorCurrent = liveFragments.readFragmentString(predecessor.fragmentKey);
  const predecessorTarget = appendBodyToFragment(predecessorCurrent, orphanBody);

  return {
    predecessorKey: predecessor.fragmentKey,
    predecessorTarget,
    predecessorIdentity: {
      headingPath: [...predecessor.headingPath],
      heading: predecessor.heading,
      level: predecessor.level,
    },
    removeKey: dirtyKey,
    removedHeadingPath: [...(effectiveLayout[idx].headingPath)],
    orphanBody,
    affectedKeys: [predecessor.fragmentKey, dirtyKey],
  };
}

/**
 * Apply a merge plan INSIDE the generator's `Y.transact`. The predecessor's
 * existing nodes keep their struct ids (append-only minimal diff); the
 * heading-deleted fragment is cleared and unregistered.
 */
export function applyStructuralMergePlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  plan: StructuralMergePlan,
  origin: unknown,
): void {
  updateFragmentPreservingIdentity(ydoc, plan.predecessorKey, plan.predecessorTarget);
  // Clear the removed fragment's nodes inside the same transaction, then drop the
  // key from the adapter so the live set converges to the post-merge layout.
  const removed = ydoc.getXmlFragment(plan.removeKey);
  while (removed.length > 0) removed.delete(0, 1);
  liveFragments.unregisterFragmentKey(plan.removeKey);
}

/**
 * Reflect a merge into the DocSession `inprogress` proposal (WS-3): fold the
 * orphan body onto the predecessor section's body, then delete the heading-
 * deleted section. The live materialize cannot observe an in-fragment heading
 * deletion (the snapshot derives identity from the layout, not fragment content),
 * so this explicit reflection is required for the proposal to follow the merge.
 */
export async function reflectMergeIntoProposal(
  proposalId: ProposalId,
  docPath: string,
  plan: StructuralMergePlan,
): Promise<void> {
  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const { ProposalReader } = await import("../storage/proposal-reader.js");
  const editor = ProposalEditor.open(proposalId, "inprogress");

  // If the deleted section has descendants, use the id-preserving keep-children
  // deletion (it removes ONLY the heading, merges its own body into the
  // predecessor, and re-parents the children KEEPING their ids — so their live
  // fragment keys/cursors survive). That single op does the whole job, so we must
  // NOT also append the orphan separately (it would double-merge).
  const reader = ProposalReader.open(proposalId, "inprogress");
  let hasChildren = false;
  try {
    const paths = await reader.listHeadingPaths(docPath);
    const target = plan.removedHeadingPath;
    hasChildren = paths.some(
      (p) => p.length > target.length && target.every((seg, i) => seg === p[i]),
    );
  } catch {
    hasChildren = false;
  }

  if (hasChildren) {
    // The catch guards ONLY the content op (the EXPECTED "no preceding sibling"
    // error → fall through to the subtree-delete + append path below); the
    // subsequent manifest update runs OUTSIDE it so a genuine manifest error is
    // never swallowed (CLAUDE.md error policy).
    let remap: { removed: FlatEntry[]; added: FlatEntry[] } | null = null;
    try {
      remap = await editor.deleteHeadingKeepingChildren(docPath, plan.removedHeadingPath);
    } catch {
      remap = null;
    }
    if (remap) {
      // Real-time manifest reparent (U1): the reparented descendants (and the
      // body-grown predecessor) are claimed at their NEW paths. The deleted
      // heading and the descendants' OLD paths are NOT dropped from the manifest —
      // the manifest only ever grows, so the deleted heading stays claimed-but-
      // absent (its delete signal) and the stale old descendant paths are harmless
      // extra claims (the merge keys surviving sections by section-file id, which
      // the reparent preserves, so a reparented descendant is never dropped).
      // Idempotent across clock-check retries: union-add dedups.
      const addClaims: ProposalSection[] = remap.added
        .filter((e) => !e.isSubSkeleton)
        .map((e) => ({ doc_path: docPath, heading_path: [...e.headingPath] }));
      const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");
      await unionCurrentProposalSections(proposalId, addClaims);
      return;
    }
  }

  // Leaf deletion (or the keep-children fallback): delete the folded-away section
  // FIRST so its (materialize-written) body does not linger, then re-write the
  // predecessor body with the orphan appended.
  await editor.deleteSection(docPath, plan.removedHeadingPath);
  // Real-time manifest (U1): the merged-away section stays CLAIMED — removing its
  // overlay content alone IS the delete (claimed-but-absent), so we never drop it
  // from the manifest. We only ever ADD claims here: the predecessor whose body
  // grew with the folded orphan. Mirrors `growProposalManifest`'s grow-only union;
  // idempotent across clock-check retries (union-add dedups).
  const add: ProposalSection[] = [];
  if (plan.orphanBody.length > 0) {
    const existing = (await editor.readSection(docPath, plan.predecessorIdentity.headingPath)) ?? EMPTY_BODY;
    const merged = appendToBody(existing, plan.orphanBody);
    const result = await editor.writeSection(
      docPath,
      plan.predecessorIdentity.headingPath,
      plan.predecessorIdentity.heading,
      // Body-only content crossing into the parser-driven write path.
      sectionWriteInputFromBody(merged),
    );
    add.push(...manifestDeltaFromResult(docPath, result).add);
  }
  const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");
  await unionCurrentProposalSections(proposalId, add);
}

// ─── NO-PREDECESSOR heading-deletion → before-first-heading (BFH) ──
//
// A heading-deleted section at layout index 0 has NO predecessor to fold into,
// so `computeStructuralMergePlan` returns null and the merge path leaves it with
// no quiescence endpoint. Its orphan body belongs under the before-first-heading
// (BFH) preamble instead: create/register BFH, move the orphan there, and delete
// the old headed identity — the same removal contract as a predecessor merge, but
// a DEDICATED plan (not a fake predecessor merge onto `StructuralMergePlan`).
// When the orphan body is empty/whitespace, no durable empty BFH is created
// (dissolve), matching the already-shipped empty-BFH dissolve behavior.
//
// NESTED first-section demotion (option B): when the demoted first section has
// DESCENDANTS, leaving it as a headed identity with no heading parenting those
// children is structural corruption. `reparentChildren` routes the proposal
// reflection through `collapseHeadingReparentingToBfh`, which moves the orphan
// body under BFH AND reparents the former children to top level KEEPING their
// section-file ids (live fragment keys survive — no live mutation of the child
// fragments is needed). The demoted headed identity is removed. The
// empty/whitespace-orphan DISSOLVE rule applies to the nested case too: the
// collapse auto-creates BFH as its reparent merge target, so the reflection
// deletes that empty preamble afterwards, and the live side never seeds BFH —
// topology hands off to the first reparented child.

export interface StructuralOrphanToBfhPlan {
  /** The demoted first headed section fragment to remove. */
  removeKey: string;
  /** Heading path of the removed headed section (for proposal `deleteSection`). */
  removedHeadingPath: string[];
  /** BFH live fragment key (`section::__beforeFirstHeading__`). */
  bfhKey: string;
  /** Full BFH fragment content (body-only; heading `""`, level 0). */
  bfhTarget: FragmentContent;
  /** The orphan body moved under BFH (for proposal reflection). */
  orphanBody: SectionBody;
  /** True when the orphan body is empty/whitespace: do NOT create a durable BFH. */
  dissolveBfh: boolean;
  /**
   * True when the demoted first section has descendants: reflect via
   * `collapseHeadingReparentingToBfh` (reparent children to top level, keep ids)
   * instead of the leaf `writeSection([]) + deleteSection` path. With an
   * empty/whitespace orphan the reflection deletes the collapse's auto-created
   * BFH merge target afterwards (`dissolveBfh` applies to both shapes).
   */
  reparentChildren: boolean;
  affectedKeys: string[];
}

/**
 * Compute the no-predecessor orphan→BFH plan for a `heading-deletion` change.
 * Runs OUTSIDE the transaction. Returns null (leave as-is, no data loss) unless
 * the dirty fragment is a HEADED section at layout index 0 (no predecessor) —
 * the case the predecessor-merge path can't handle.
 *
 *  - LEAF (no descendants): orphan body → BFH (or dissolve when empty), delete
 *    the demoted headed identity.
 *  - NESTED (has descendants, option B): reflect via
 *    `collapseHeadingReparentingToBfh` — orphan body under BFH (or dissolved
 *    when empty), former children reparented to top level KEEPING their
 *    section-file ids, demoted identity removed. `reparentChildren` is set so
 *    the reflection takes that path; the live side is identical to the leaf
 *    case (seed BFH — or not, when dissolving — + clear the demoted key; child
 *    fragments keep their keys and are untouched).
 */
export async function computeStructuralOrphanToBfhPlan(
  liveFragments: LiveFragmentStringsStore,
  docPath: string,
  currentProposalId: ProposalId | null,
  dirtyKey: string,
  change: Extract<StructuralChange, { kind: "heading-deletion" }>,
): Promise<StructuralOrphanToBfhPlan | null> {
  const layout: LiveSectionLayoutEntry[] = await resolveLiveSectionLayout(docPath, currentProposalId);
  const idx = layout.findIndex((e) => e.fragmentKey === dirtyKey);
  // Only the first section, and only a headed one (a body-only BFH never
  // classifies as heading-deletion). Anything else is not the no-predecessor
  // hole — let the caller `continue`.
  if (idx !== 0) return null;
  const removed = layout[0];
  if (removed.headingPath.length === 0) return null;

  // Detect descendants: a demoted first section with children reparents them to
  // top level (option B) rather than deleting the subtree. `collapseHeading-
  // ReparentingToBfh` (via `collapseParentHeading`) requires a proposal + a
  // readable sub-skeleton parent; with no proposal there can be no descendants,
  // so the leaf path is correct.
  let reparentChildren = false;
  if (currentProposalId) {
    const { ProposalReader } = await import("../storage/proposal-reader.js");
    try {
      const paths = await ProposalReader.open(currentProposalId, "inprogress").listHeadingPaths(docPath);
      const target = removed.headingPath;
      reparentChildren = paths.some(
        (p) => p.length > target.length && target.every((seg, i) => seg === p[i]),
      );
    } catch {
      // No readable layout → treat as leaf (nothing to reparent).
    }
  }

  const orphanBody = change.orphanedBody;
  // An empty/whitespace orphan dissolves BFH in BOTH shapes: leaf (no BFH is
  // created at all) and nested (the reflection removes the collapse's
  // auto-created merge target), so no phantom empty preamble ever survives.
  const dissolveBfh = orphanBody.trim() === "";
  return {
    removeKey: dirtyKey,
    removedHeadingPath: [...removed.headingPath],
    bfhKey: BEFORE_FIRST_HEADING_KEY,
    bfhTarget: buildFragmentContent(orphanBody, 0, ""),
    orphanBody,
    dissolveBfh,
    reparentChildren,
    affectedKeys: dissolveBfh
      ? [dirtyKey]
      : [BEFORE_FIRST_HEADING_KEY, dirtyKey],
  };
}

/**
 * Apply a no-predecessor orphan→BFH plan INSIDE the generator's `Y.transact`.
 * Seeds a fresh BFH fragment with the orphan body (identity is new — this uses
 * the seed path, never a survivor rewrite), then clears + unregisters the removed
 * headed fragment so the live set converges to the post-demotion layout. When
 * dissolving, no BFH is seeded — only the headed fragment is removed.
 */
export function applyStructuralOrphanToBfhPlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  plan: StructuralOrphanToBfhPlan,
  origin: unknown,
): void {
  if (!plan.dissolveBfh) {
    // BFH is a genuinely-new live fragment here (the doc had no preamble), so the
    // seed path is correct — identity does not matter for a fragment that did not
    // exist. `replaceFragmentString` also registers the key with the adapter.
    liveFragments.replaceFragmentString(plan.bfhKey, plan.bfhTarget, origin);
  }
  const removed = ydoc.getXmlFragment(plan.removeKey);
  while (removed.length > 0) removed.delete(0, 1);
  liveFragments.unregisterFragmentKey(plan.removeKey);
}

/**
 * Reflect a no-predecessor orphan→BFH into the DocSession `inprogress` proposal.
 * Writes the orphan as the BFH preamble body (a `[]` write is body-only and never
 * parsed for structure — embedded heading syntax stays literal, matching the live
 * BFH fragment), then deletes the demoted headed section. On dissolve, only the
 * headed section is deleted (no durable empty BFH). Mirrors `reflectMergeIntoProposal`'s
 * grow-only manifest union; the deleted heading rides the id-based delete overlay.
 */
export async function reflectOrphanToBfhIntoProposal(
  proposalId: ProposalId,
  docPath: string,
  plan: StructuralOrphanToBfhPlan,
): Promise<void> {
  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const editor = ProposalEditor.open(proposalId, "inprogress");
  const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");

  // Nested (option B): one collapse folds the orphan under BFH, reparents the
  // former children to top level keeping their ids, and removes the demoted
  // headed identity. Claim the written entries (reparented children + BFH) at
  // their NEW paths (grow-only union); the demoted heading rides the id-based
  // delete overlay recorded by `collapseHeadingReparentingToBfh`.
  if (plan.reparentChildren) {
    const result = await editor.collapseHeadingReparentingToBfh(
      docPath,
      plan.removedHeadingPath,
      plan.orphanBody,
    );
    let add = manifestDeltaFromResult(docPath, result).add;
    if (plan.dissolveBfh) {
      // The collapse auto-creates BFH as its reparent merge target; an
      // empty/whitespace orphan must not leave that empty preamble behind —
      // delete it and never claim the `[]` path in the manifest.
      await editor.deleteSection(docPath, []);
      add = add.filter((section) => section.heading_path.length > 0);
    }
    await unionCurrentProposalSections(proposalId, add);
    return;
  }

  // Leaf: write the orphan as the BFH preamble body (unless dissolving an empty
  // orphan), then delete the demoted headed section.
  if (!plan.dissolveBfh) {
    const result = await editor.writeSection(
      docPath,
      [],
      "",
      sectionWriteInputFromBody(plan.orphanBody),
    );
    await unionCurrentProposalSections(proposalId, manifestDeltaFromResult(docPath, result).add);
  }
  // Delete the demoted headed section. Its canonical section-file id enters the
  // proposal's `deleted_section_files`, so the effective layout drops it by id.
  await editor.deleteSection(docPath, plan.removedHeadingPath);
}

// ─── SPLIT (embedded heading promoted) — proposal reflection ──────

/**
 * Reflect a settled split into the `inprogress` proposal (WS-3), promoting an
 * embedded heading the author typed into a section body into a real section.
 *
 * Per-edit materialization is TOPOLOGY-NEUTRAL (it stores section bodies
 * verbatim, embedded heading and all), so at quiescence the proposal still
 * carries the heading as literal body text — this reflection is what actually
 * splits the proposal. It MUST run BEFORE `computeStructuralSplitPlan`, which
 * derives the live reshape (and new live fragment keys) from the resulting
 * proposal layout.
 *
 *  - section-split (a real heading path): the live fragment markdown is the
 *    section's full fragment (its own heading + body + the embedded heading).
 *    The parser-driven `writeSection(headingPath, …, { contentIsFullMarkdown })`
 *    trims the survivor body and creates the embedded section once, REUSING the
 *    survivor's `sectionFile` id (WS-0). Idempotent via the upsert identity
 *    short-circuit.
 *  - root-split (BFH, `headingPath: []`): a `[]` write is body-only and cannot
 *    promote structure, so the dedicated BFH-split primitive inserts the
 *    promoted heading at the front, preserving the orphan as the BFH body and
 *    every existing section id. Idempotent via its own already-promoted guard.
 *
 * Both branches are no-ops on a retry whose prior live apply aborted, so a
 * clock-check abort cannot duplicate proposal sections (item 23).
 */
export async function reflectSplitIntoProposal(
  proposalId: ProposalId,
  docPath: string,
  fragmentMarkdown: string,
  identity: { headingPath: readonly string[]; heading: string },
): Promise<void> {
  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const { sectionWriteInputFromExternal } = await import("../storage/section-formatting.js");
  const editor = ProposalEditor.open(proposalId, "inprogress");

  const result =
    identity.headingPath.length === 0
      ? await editor.splitBeforeFirstHeading(docPath, fragmentMarkdown)
      : await editor.writeSection(
          docPath,
          [...identity.headingPath],
          identity.heading,
          sectionWriteInputFromExternal(fragmentMarkdown),
          { contentIsFullMarkdown: true },
        );

  // Real-time manifest claim (placement decision in assumptions.md): claim the
  // promoted section AT QUIESCENCE, here where the content promotion happens, not
  // only at publish. The manifest is GROW-ONLY (D6): ADD body-bearing written
  // entries — the promoted `["Overview","Sub"]` / `["h3 added"]` — leaving the
  // survivor's existing claim intact and NEVER shrinking it. Deletes ride the
  // id-based `deleted_section_files` set, not a manifest path-claim removal.
  // Idempotent across clock-check retries: union-add dedups.
  const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");
  const { add } = manifestDeltaFromResult(docPath, result);
  await unionCurrentProposalSections(proposalId, add);
}

// ─── RENAME / LEVEL-CHANGE / RELOCATED (heading edits) ────────────

/**
 * A precomputed identity-preserving heading edit. The author already typed the
 * new heading text / level / position into the live fragment, so the LIVE side
 * is canonicalized in place (heading node edited, body kept) via the minimal
 * diff. The proposal side renames/re-levels to follow (WS-3).
 */
export interface StructuralHeadingEditPlan {
  fragmentKey: string;
  /** The full target fragment content (heading line at the new shape + body). */
  target: FragmentContent;
  /** Authoritative pre-edit identity (for proposal reflection). */
  fromHeadingPath: string[];
  /** New heading text. */
  newHeading: string;
  /** New level (unchanged for a pure rename). */
  newLevel: number;
  affectedKeys: string[];
}

/**
 * Compute the heading-edit plan for a rename / level-change / relocated change.
 * Runs OUTSIDE the transaction.
 */
export function computeStructuralHeadingEditPlan(
  liveFragments: LiveFragmentStringsStore,
  dirtyKey: string,
  identity: { headingPath: readonly string[] },
  change: Extract<StructuralChange, { kind: "heading-rename" | "heading-level-change" | "heading-relocated" }>,
): StructuralHeadingEditPlan {
  const newHeading = change.kind === "heading-relocated" ? change.heading : change.newHeading;
  const newLevel =
    change.kind === "heading-level-change"
      ? change.newLevel
      : change.kind === "heading-rename"
        ? change.level
        : change.level;

  // For relocated, the canonical body is heading + combined body. For
  // rename/level-change, the body is whatever currently follows the heading.
  let target: FragmentContent;
  if (change.kind === "heading-relocated") {
    target = buildFragmentContent(change.combinedBody, newLevel, newHeading);
  } else {
    const current = liveFragments.readFragmentString(dirtyKey);
    // Strip the (possibly wrong-level / multiple) leading heading lines the parser
    // already accounted for, by rebuilding from the parsed single section's body.
    // The simplest correct target is the live content with its heading line
    // normalized: re-derive body from the live fragment minus its first heading.
    const body = bodyFromFragmentStrippingLeadingHeading(current);
    target = buildFragmentContent(body, newLevel, newHeading);
  }

  return {
    fragmentKey: dirtyKey,
    target,
    fromHeadingPath: [...identity.headingPath],
    newHeading,
    newLevel,
    affectedKeys: [dirtyKey],
  };
}

/**
 * Apply a heading-edit plan INSIDE the transaction. The minimal diff keeps the
 * body nodes (they are unchanged) and edits/replaces only the heading node.
 */
export function applyStructuralHeadingEditPlan(
  ydoc: Y.Doc,
  plan: StructuralHeadingEditPlan,
): void {
  updateFragmentPreservingIdentity(ydoc, plan.fragmentKey, plan.target);
}

/**
 * Reflect a rename / level-change into the proposal (WS-3). A level change is a
 * move to the same parent at a new level; a pure rename is `renameSection`. The
 * relocated case needs no proposal reflection beyond the body rewrite (the
 * heading identity is unchanged), which the live materialize already captured.
 */
export async function reflectHeadingEditIntoProposal(
  proposalId: ProposalId,
  docPath: string,
  plan: StructuralHeadingEditPlan,
  kind: StructuralChange["kind"],
): Promise<void> {
  // heading-relocated: same identity, only the body order changed — the live
  // materialize already captured the combined body; nothing structural to do.
  if (kind === "heading-relocated") return;

  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const editor = ProposalEditor.open(proposalId, "inprogress");
  // Rename AND level-change both go through the id-preserving in-place retitle so
  // the section-file id (and thus the live fragment key) is preserved — a
  // re-keying renameSection/moveSection would diverge the proposal from the
  // identity-preserved live fragment. The corrected stripped body is written too
  // (materialize may have left a wrong-level heading embedded in the body).
  const body = bodyFromFragmentStrippingLeadingHeading(plan.target);
  const newEntry = await editor.retitleSection(docPath, plan.fromHeadingPath, plan.newHeading, plan.newLevel, body);

  // Identity-based delete detection (D6): the manifest is now GROW-ONLY — no
  // path-remap on rename. Deletes ride the id-based `deleted_section_files` set,
  // not a manifest path-claim, so a renamed ancestor no longer needs its
  // descendants' delete-claims re-pathed (the merge keys deletes by stable
  // section-file id, which the id-preserving retitle keeps). CLAIM the renamed
  // section at its NEW path (grow-only union) so locks/audit cover it; the section
  // keeps its id, so the merge tracks it by id regardless of which path is claimed.
  // Stale old-path claims left in the manifest are harmless extra claims.
  const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");
  await unionCurrentProposalSections(proposalId, [
    { doc_path: docPath, heading_path: [...newEntry.headingPath] },
  ]);
}
