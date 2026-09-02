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
import { buildFragmentContent, EMPTY_BODY, appendBodyToFragment, bodyFromFragmentStrippingLeadingHeading, type FragmentContent, type SectionBody } from "../storage/section-formatting.js";
import { SectionRef } from "../domain/section-ref.js";
import { resolveLiveSectionLayout, readLiveSectionBodies } from "./live-section-layout.js";
import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile, getBackendSchema } from "./ydoc-fragments.js";
import type { LiveFragmentStringsStore } from "./live-fragment-strings-store.js";
import type { StructuralChange } from "./structural-change.js";
import type { ProposalId, ProposalSectionClaim } from "../types/shared.js";
import type { HeadingLevel } from "../types/shared.js";
import type { UpsertSectionFromMarkdownDetailedResult } from "../storage/content-layer.js";
import type { HeadingRemovalEffect } from "../storage/document-skeleton.js";
import type { DocPath } from "../types/shared.js";

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
  docPath: DocPath,
  result: UpsertSectionFromMarkdownDetailedResult,
): { add: ProposalSectionClaim[]; remove: ProposalSectionClaim[] } {
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
  /**
   * Delete survivor children in [0, deleteLeadingUntil): the nodes belonging to
   * `before` sections (plus any orphan preamble the classification folded into
   * the survivor body). 0 = nothing leads the survivor's own heading.
   */
  deleteLeadingUntil: number;
  /** Delete survivor children from this index to the end (the moved-out content). */
  deleteFrom: number;
  /**
   * The survivor's reflected content (its heading + classified body). After the
   * range deletes, the applier converges the fragment onto this via the
   * identity-preserving minimal diff — only needed when the classification
   * folded orphan preamble into the survivor body, a shape range deletes alone
   * cannot reach. Null for root-split (the BFH survivor keeps its nodes as-is).
   */
  survivorTarget: FragmentContent | null;
  /** New fragment key → its full content, seeded fresh (no prior identity). */
  seeds: Map<string, FragmentContent>;
  /** Fragment keys this plan touches, for the generator's pre-flight clock check. */
  affectedKeys: string[];
  /**
   * Bootstrap BFH dissolve on empty-preamble root-split. When the survivor is
   * the before-first-heading fragment AND the surviving `rootBody` is empty/
   * whitespace, the applier unregisters the BFH live fragment key after clearing
   * its children so it leaves the effective layout. The coordinator additionally
   * removes BFH from the proposal skeleton (`deleteSubtree([])`) and emits
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
 *    and `partitionLiveFragmentsByStructuralCleanliness` strips that heading at the parent level on re-snapshot).
 *  - New sections are whatever layout keys are absent from the live set; each is
 *    seeded from the proposal body at its authoritative heading/level.
 *
 * Returns null when there is nothing to add (the proposal layout introduced no
 * new fragment key — defensive; the classifier already gated on realSections).
 */
export async function computeStructuralSplitPlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  docPath: DocPath,
  currentProposalId: ProposalId | null,
  dirtyKey: string,
  change: Extract<StructuralChange, { kind: "root-split" | "section-split" }>,
): Promise<StructuralSplitPlan | null> {
  const layout = await resolveLiveSectionLayout(docPath, currentProposalId);
  const liveKeys = new Set(liveFragments.getFragmentKeys());
  const addedEntries = layout.filter((e) => !liveKeys.has(e.fragmentKey));
  if (addedEntries.length === 0) return null;

  // Moved-out boundaries. root-split: everything from the 1st heading onward
  // moves out. section-split: the survivor is the (before.length + 1)th heading —
  // leading nodes before it (the `before` sections + any preamble) move out, and
  // everything from the first `after` heading onward moves out.
  const survivorOrdinal = change.kind === "root-split" ? 0 : change.before.length + 1;
  const deleteFrom = indexOfNthHeading(ydoc, dirtyKey, survivorOrdinal + 1);
  const deleteLeadingUntil =
    change.kind === "root-split" ? 0 : indexOfNthHeading(ydoc, dirtyKey, survivorOrdinal);
  const survivorTarget =
    change.kind === "section-split"
      ? buildFragmentContent(change.survivor.body, change.survivor.headingLevel, change.survivor.heading)
      : null;

  // Seed each new fragment from the current proposal's effective body at its
  // authoritative shape — through the proposal-bound reader for the current
  // `inprogress` proposal, or a canonical-only read when there is no proposal.
  const bulkContent = await readLiveSectionBodies(docPath, currentProposalId);

  const seeds = new Map<string, FragmentContent>();
  for (const entry of addedEntries) {
    const body = bulkContent?.get(SectionRef.headingKey(entry.headingPath)) ?? EMPTY_BODY;
    seeds.set(entry.fragmentKey, buildFragmentContent(body, entry.headingLevel, entry.heading));
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
    deleteLeadingUntil,
    deleteFrom,
    survivorTarget,
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
  // Delete the moved-out trailing nodes (the survivor keeps its heading + body),
  // then the moved-out leading nodes (`before` sections + preamble). Trailing
  // first so the leading indices stay valid.
  if (plan.deleteFrom < frag.length) {
    frag.delete(plan.deleteFrom, frag.length - plan.deleteFrom);
  }
  if (plan.deleteLeadingUntil > 0) {
    frag.delete(0, Math.min(plan.deleteLeadingUntil, frag.length));
  }
  // Converge the survivor onto its reflected content when the range deletes
  // alone cannot reach it (preamble folded into the survivor body). The
  // minimal diff keeps the survivor's heading/body struct ids in the common case
  // where the content already matches.
  if (plan.survivorTarget !== null && liveFragments.readFragmentString(plan.survivorKey) !== plan.survivorTarget) {
    updateFragmentPreservingIdentity(ydoc, plan.survivorKey, plan.survivorTarget);
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

// ─── HEADING REMOVAL (heading-deletion → one durable engine) ──────

/**
 * The live half of a settled heading deletion, derived ENTIRELY from the
 * proposal engine's `HeadingRemovalEffect` — the durable proposal mutation runs
 * FIRST (`removeProposalHeading`), and this plan only mirrors its declared
 * outcome onto the live Y.Doc. The applier never reads layout to choose a
 * different structural outcome.
 */
export interface HeadingRemovalPlan {
  /** The removed heading's live fragment (cleared + unregistered). */
  removeKey: string;
  /** Heading path the removed fragment carried (for tombstones / section:gone). */
  removedHeadingPath: string[];
  /** The declared merge target's fragment key, or null when the effect declared
   *  no merge target (nothing precedes and no body content had to survive). */
  mergeTargetKey: string | null;
  /** Full fragment content to SEED when the merge-target fragment is not live
   *  yet (a created document-start BFH, or an inherited section the session
   *  never registered). Null when the effect wrote no merge-target body. */
  mergeTargetSeedContent: FragmentContent | null;
  /** The authoritative orphan body appended to an already-live merge target. */
  orphanBody: SectionBody;
  affectedKeys: string[];
}

/** Derive the live plan from the completed proposal effect. Pure — no layout
 *  reads, no Y.Doc reads; content is read at apply time inside the transaction. */
export function deriveHeadingRemovalPlan(
  effect: HeadingRemovalEffect,
  orphanBody: SectionBody,
  removedHeadingPath: string[],
): HeadingRemovalPlan {
  const removeKey = fragmentKeyFromSectionFile(effect.removedBodySectionFile, false);
  let mergeTargetKey: string | null = null;
  let mergeTargetSeedContent: FragmentContent | null = null;
  if (effect.mergeTarget) {
    const mergeTarget = effect.mergeTarget;
    mergeTargetKey = fragmentKeyFromSectionFile(
      mergeTarget.newEntry.sectionFile,
      mergeTarget.visibleHeadingPath.length === 0,
    );
    if (mergeTarget.mergedBody !== null) {
      mergeTargetSeedContent = buildFragmentContent(
        mergeTarget.mergedBody as SectionBody,
        mergeTarget.visibleHeadingLevel,
        mergeTarget.visibleHeading,
      );
    }
  }
  return {
    removeKey,
    removedHeadingPath: [...removedHeadingPath],
    mergeTargetKey,
    mergeTargetSeedContent,
    orphanBody,
    affectedKeys: mergeTargetKey ? [mergeTargetKey, removeKey] : [removeKey],
  };
}

/**
 * Apply a heading-removal plan INSIDE the generator's `Y.transact`. An
 * already-live merge target keeps its struct ids (append-only minimal diff over
 * its CURRENT content); a not-yet-live merge target is seeded fresh from the
 * effect's merged body. The removed fragment is cleared and unregistered.
 * Preserved descendant fragments are untouched — their keys did not change.
 */
export function applyHeadingRemovalPlan(
  liveFragments: LiveFragmentStringsStore,
  ydoc: Y.Doc,
  plan: HeadingRemovalPlan,
  origin: unknown,
): void {
  if (plan.mergeTargetKey !== null) {
    if (liveFragments.hasFragmentKey(plan.mergeTargetKey)) {
      if (plan.orphanBody.trim() !== "") {
        const current = liveFragments.readFragmentString(plan.mergeTargetKey);
        updateFragmentPreservingIdentity(
          ydoc,
          plan.mergeTargetKey,
          appendBodyToFragment(current, plan.orphanBody),
        );
      }
    } else if (plan.mergeTargetSeedContent !== null) {
      liveFragments.replaceFragmentString(plan.mergeTargetKey, plan.mergeTargetSeedContent, origin);
    }
  }
  const removed = ydoc.getXmlFragment(plan.removeKey);
  while (removed.length > 0) removed.delete(0, 1);
  liveFragments.unregisterFragmentKey(plan.removeKey);
}


// ─── SPLIT (embedded heading promoted) — proposal reflection ──────

/**
 * Reflect a settled split into the `inprogress` proposal (WS-3), promoting the
 * embedded heading(s) the author typed into a section body into real sections.
 * Consumes the classifier's already-parsed split shape — one classifier verdict
 * per settle pass; reflection never re-derives its own.
 *
 *  - section-split: when `renamedFromIdentity`, the survivor is first retitled
 *    in place to its new heading/level (id-preserving). Then the survivor +
 *    `after` sections are written through the parser-driven
 *    `writeSection(survivorPath, …, { expandHeadingsIntoSections })` — the
 *    first-heading==explicit-heading precondition holds by construction because
 *    the markdown is rebuilt from the survivor descriptor itself. Each `before`
 *    section is created via `createSection` and ordered above the survivor via
 *    `reorderSection(position: "before")`.
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
  docPath: DocPath,
  change: Extract<StructuralChange, { kind: "root-split" | "section-split" }>,
  identity: { headingPath: readonly string[]; heading: string },
): Promise<void> {
  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const { sectionWriteInputFromExternal } = await import("../storage/section-formatting.js");
  const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");
  const editor = ProposalEditor.open(proposalId, "inprogress");

  // Real-time manifest claim (placement decision in assumptions.md): claim the
  // promoted sections AT QUIESCENCE, here where the content promotion happens,
  // not only at publish. The manifest is GROW-ONLY (D6); union-add dedups
  // across clock-check retries. Deletes ride the id-based
  // `deleted_section_files` set, not a manifest path-claim removal.
  if (change.kind === "root-split") {
    const parts: string[] = [];
    if (change.rootBody.trim() !== "") parts.push(change.rootBody);
    for (const s of change.sections) parts.push(buildFragmentContent(s.body, s.headingLevel, s.heading));
    const result = await editor.splitBeforeFirstHeading(docPath, parts.join("\n\n"));
    await unionCurrentProposalSections(proposalId, manifestDeltaFromResult(docPath, result).add);
    return;
  }

  let survivorPath = [...identity.headingPath];
  if (change.survivor.renamedFromIdentity) {
    await editor.retitleSection(
      docPath,
      survivorPath,
      change.survivor.heading,
      change.survivor.headingLevel,
      change.survivor.body,
    );
    survivorPath = [...identity.headingPath.slice(0, -1), change.survivor.heading];
  }

  const survivorMarkdown = [
    buildFragmentContent(change.survivor.body, change.survivor.headingLevel, change.survivor.heading),
    ...change.after.map((s) => buildFragmentContent(s.body, s.headingLevel, s.heading)),
  ].join("\n\n");
  const writeResult = await editor.writeSection(
    docPath,
    survivorPath,
    change.survivor.heading,
    sectionWriteInputFromExternal(survivorMarkdown),
    { expandHeadingsIntoSections: true },
  );
  const add = [...manifestDeltaFromResult(docPath, writeResult).add];

  const parentPath = [...identity.headingPath.slice(0, -1)];
  for (const s of change.before) {
    const createResult = await editor.createSection(
      docPath,
      [...parentPath, ...s.headingPath],
      s.heading,
      sectionWriteInputFromExternal(buildFragmentContent(s.body, s.headingLevel, s.heading)),
    );
    add.push(...manifestDeltaFromResult(docPath, createResult).add);
  }
  for (const s of change.before) {
    if (s.headingPath.length !== 1) continue;
    await editor.reorderSection(docPath, [...parentPath, ...s.headingPath], survivorPath, "before");
  }

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
  newHeadingLevel: HeadingLevel;
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
  const newHeadingLevel =
    change.kind === "heading-level-change"
      ? change.newHeadingLevel
      : change.kind === "heading-rename"
        ? change.headingLevel
        : change.headingLevel;

  // For relocated, the canonical body is heading + combined body. For
  // rename/level-change, the body is whatever currently follows the heading.
  let target: FragmentContent;
  if (change.kind === "heading-relocated") {
    target = buildFragmentContent(change.combinedBody, newHeadingLevel, newHeading);
  } else {
    const current = liveFragments.readFragmentString(dirtyKey);
    // Strip the (possibly wrong-level / multiple) leading heading lines the parser
    // already accounted for, by rebuilding from the parsed single section's body.
    // The simplest correct target is the live content with its heading line
    // normalized: re-derive body from the live fragment minus its first heading.
    const body = bodyFromFragmentStrippingLeadingHeading(current);
    target = buildFragmentContent(body, newHeadingLevel, newHeading);
  }

  return {
    fragmentKey: dirtyKey,
    target,
    fromHeadingPath: [...identity.headingPath],
    newHeading,
    newHeadingLevel,
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

/** True when `prefix` is a (non-strict) prefix of `path` — i.e. `path` is the
 *  target itself or one of its descendants. */
function headingPathHasPrefix(prefix: string[], path: string[]): boolean {
  if (path.length < prefix.length) return false;
  return prefix.every((seg, i) => path[i] === seg);
}

/**
 * Every effective heading path of the inprogress proposal's document that lies
 * at or under `prefix` — the subtree a rename re-keys, which overlay ownership
 * reports as owned at those NEW addresses.
 */
async function effectiveSubtreeHeadingPaths(
  proposalId: ProposalId,
  docPath: DocPath,
  prefix: string[],
): Promise<string[][]> {
  const { ProposalReader } = await import("../storage/proposal-reader.js");
  const reader = ProposalReader.open(proposalId, "inprogress");
  const headingPaths = await reader.listHeadingPaths(docPath);
  return headingPaths.filter((path) => headingPathHasPrefix(prefix, path));
}

/**
 * Reflect a rename / level-change into the proposal (WS-3). A level change is a
 * move to the same parent at a new level; a pure rename is `renameSection`. The
 * relocated case needs no proposal reflection beyond the body rewrite (the
 * heading identity is unchanged), which the live materialize already captured.
 */
export async function reflectHeadingEditIntoProposal(
  proposalId: ProposalId,
  docPath: DocPath,
  plan: StructuralHeadingEditPlan,
  kind: StructuralChange["kind"],
): Promise<void> {
  const { ProposalEditor } = await import("../storage/proposal-editor.js");
  const editor = ProposalEditor.open(proposalId, "inprogress");
  const body = bodyFromFragmentStrippingLeadingHeading(plan.target);
  const { unionCurrentProposalSections } = await import("../storage/proposal-repository.js");

  if (kind === "heading-relocated") {
    await editor.writeSectionBodyVerbatim(docPath, plan.fromHeadingPath, body);
    await unionCurrentProposalSections(proposalId, [
      { doc_path: docPath, heading_path: [...plan.fromHeadingPath] },
    ]);
    return;
  }

  const newEntry = await editor.retitleSection(docPath, plan.fromHeadingPath, plan.newHeading, plan.newHeadingLevel, body);
  const reKeyed = await effectiveSubtreeHeadingPaths(proposalId, docPath, newEntry.headingPath);
  await unionCurrentProposalSections(
    proposalId,
    reKeyed.map((heading_path) => ({ doc_path: docPath, heading_path: [...heading_path] })),
  );
}
