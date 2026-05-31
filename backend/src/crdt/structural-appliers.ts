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
import { buildFragmentContent, EMPTY_BODY, appendToBody, type FragmentContent, type SectionBody } from "../storage/section-formatting.js";
import { SectionRef } from "../domain/section-ref.js";
import { resolveLiveSectionLayout, type LiveSectionLayoutEntry } from "./live-section-layout.js";
import { getBackendSchema } from "./ydoc-fragments.js";
import type { LiveFragmentStringsStore } from "./live-fragment-strings-store.js";
import type { StructuralChange } from "./structural-change.js";
import type { ProposalId } from "../types/shared.js";

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
  const targetNode = getBackendSchema().nodeFromJSON(markdownToJSON(targetMarkdown as string));
  updateYFragment(ydoc, frag, targetNode, { mapping: new Map(), isOMark: new Map() });
}

/**
 * A precomputed identity-preserving split: mutate the survivor fragment in place
 * (delete the moved-out trailing nodes; optionally strip the leading heading when
 * the survivor became a body-holder) and seed each genuinely-new fragment.
 */
export interface StructuralSplitPlan {
  survivorKey: string;
  /** Delete survivor children from this index to the end (the moved-out content). */
  deleteFrom: number;
  /** Strip the leading heading node (survivor became a body-holder body-only). */
  stripLeadingHeading: boolean;
  /** New fragment key → its full content, seeded fresh (no prior identity). */
  seeds: Map<string, FragmentContent>;
  /** Fragment keys this plan touches, for the generator's pre-flight clock check. */
  affectedKeys: string[];
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
 *  - The survivor is the dirty fragment itself (its key is preserved by WS-0's
 *    survivor id-reuse, so the live key already matches the proposal layout).
 *  - The moved-out content is everything from the first NEW heading onward:
 *      • section-split: from the SECOND heading (the first heading is the
 *        survivor's own heading);
 *      • root-split: from the FIRST heading (the root/BFH survivor has no heading).
 *  - When the survivor became a sub-skeleton parent its body now lives in a
 *    body-holder (the layout entry for the survivor key carries heading="" at
 *    level 0 under a non-empty heading path), so the leading heading node is
 *    stripped — leaving the survivor fragment body-only, which is what the live
 *    source's re-snapshot expects. A sibling-split survivor keeps its heading.
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

  // Survivor body-holder detection: after a child-split the survivor's key maps
  // to a body-holder (heading="" / level 0) under a real heading path.
  const survivorEntry = layout.find((e) => e.fragmentKey === dirtyKey);
  const survivorIsBodyHolder =
    !!survivorEntry &&
    survivorEntry.heading === "" &&
    survivorEntry.level === 0 &&
    survivorEntry.headingPath.length > 0;

  // Moved-out boundary: the first NEW heading. root-split → 1st heading;
  // section-split → 2nd heading (the survivor owns the 1st).
  const headingOrdinal = change.kind === "root-split" ? 1 : 2;
  const deleteFrom = indexOfNthHeading(ydoc, dirtyKey, headingOrdinal);

  // Seed each new fragment from the proposal body at its authoritative shape.
  const { proposalContentRoot } = await import("../storage/proposal-repository.js");
  const { ProposalShadowContentLayer } = await import("../storage/content-layer.js");
  const { getContentRoot } = await import("../storage/data-root.js");
  const seedRoot = currentProposalId
    ? proposalContentRoot(currentProposalId, "inprogress")
    : getContentRoot();
  const seedLayer = new ProposalShadowContentLayer(seedRoot, getContentRoot());
  const bulkContent = await seedLayer.readAllSections(docPath);

  const seeds = new Map<string, FragmentContent>();
  for (const entry of addedEntries) {
    const body = (bulkContent?.get(SectionRef.headingKey(entry.headingPath)) ?? EMPTY_BODY) as SectionBody;
    seeds.set(entry.fragmentKey, buildFragmentContent(body, entry.level, entry.heading));
  }

  return {
    survivorKey: dirtyKey,
    deleteFrom,
    stripLeadingHeading: survivorIsBodyHolder,
    seeds,
    affectedKeys: [dirtyKey, ...addedEntries.map((e) => e.fragmentKey)],
  };
}

/**
 * Apply a precomputed split plan INSIDE the generator's `Y.transact`. The
 * survivor's surviving children keep their struct ids; only the moved-out
 * trailing nodes (and, for a body-holder survivor, the leading heading) are
 * tombstoned. New fragments are seeded fresh.
 */
export function applyStructuralSplitPlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  plan: StructuralSplitPlan,
  origin: unknown,
): void {
  const frag = ydoc.getXmlFragment(plan.survivorKey);
  // Delete the moved-out trailing nodes first (higher indices), so the leading
  // heading strip below operates on stable indices.
  if (plan.deleteFrom < frag.length) {
    frag.delete(plan.deleteFrom, frag.length - plan.deleteFrom);
  }
  // Strip the leading heading node when the survivor became a body-holder.
  if (plan.stripLeadingHeading && frag.length > 0 && isHeadingNode(frag.get(0))) {
    frag.delete(0, 1);
  }
  // Seed genuinely-new fragments (identity does not matter — they are new).
  for (const [key, content] of plan.seeds) {
    liveFragments.replaceFragmentString(key, content, origin);
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
  dirtyKey: string,
  change: Extract<StructuralChange, { kind: "heading-deletion" }>,
): Promise<StructuralMergePlan | null> {
  // Resolve doc order from the CANONICAL layout (the pre-edit structure): the
  // predecessor is the section immediately before the dirty one.
  const canonicalLayout: LiveSectionLayoutEntry[] = await resolveLiveSectionLayout(docPath, null);
  const idx = canonicalLayout.findIndex((e) => e.fragmentKey === dirtyKey);
  if (idx <= 0) return null; // no predecessor in document order
  const predecessor = canonicalLayout[idx - 1];

  const orphanBody = change.orphanedBody;
  const predecessorCurrent = liveFragments.readFragmentString(predecessor.fragmentKey) as string;
  const predecessorTarget = (
    (orphanBody as string).length === 0
      ? predecessorCurrent
      : predecessorCurrent.trim().length === 0
        ? (orphanBody as string)
        : `${predecessorCurrent.replace(/\n+$/, "")}\n\n${orphanBody as string}`
  ) as FragmentContent;

  return {
    predecessorKey: predecessor.fragmentKey,
    predecessorTarget,
    predecessorIdentity: {
      headingPath: [...predecessor.headingPath],
      heading: predecessor.heading,
      level: predecessor.level,
    },
    removeKey: dirtyKey,
    removedHeadingPath: [...(canonicalLayout[idx].headingPath)],
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
    try {
      await editor.deleteHeadingKeepingChildren(docPath, plan.removedHeadingPath);
      return;
    } catch {
      // No preceding sibling (e.g. predecessor is the BFH) — fall through to the
      // subtree-delete + append path below.
    }
  }

  // Leaf deletion (or the keep-children fallback): delete the folded-away section
  // FIRST so its (materialize-written) body does not linger, then re-write the
  // predecessor body with the orphan appended.
  await editor.deleteSection(docPath, plan.removedHeadingPath);
  if ((plan.orphanBody as string).length > 0) {
    const existing = (await editor.readSection(docPath, plan.predecessorIdentity.headingPath)) ?? "";
    const merged = appendToBody(existing as SectionBody, plan.orphanBody);
    await editor.writeSection(
      docPath,
      plan.predecessorIdentity.headingPath,
      plan.predecessorIdentity.heading,
      merged as unknown as string,
    );
  }
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
    const current = liveFragments.readFragmentString(dirtyKey) as string;
    // Strip the (possibly wrong-level / multiple) leading heading lines the parser
    // already accounted for, by rebuilding from the parsed single section's body.
    // The simplest correct target is the live content with its heading line
    // normalized: re-derive body from the live fragment minus its first heading.
    const body = stripFirstHeadingLine(current);
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

/** Strip the first ATX heading line (and following blank line) from markdown. */
function stripFirstHeadingLine(markdown: string): SectionBody {
  const lines = markdown.split("\n");
  if (lines.length > 0 && /^#{1,6}\s/.test(lines[0])) {
    let start = 1;
    while (start < lines.length && lines[start].trim() === "") start += 1;
    return lines.slice(start).join("\n").replace(/\n+$/, "") as SectionBody;
  }
  return markdown.replace(/\n+$/, "") as SectionBody;
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
  const body = stripFirstHeadingLine(plan.target as string);
  await editor.retitleSection(docPath, plan.fromHeadingPath, plan.newHeading, plan.newLevel, body as unknown as string);
}
