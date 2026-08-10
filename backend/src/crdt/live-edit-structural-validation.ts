/**
 * CRDT live-edit structural validation — the first ingress rejection rule.
 *
 * Detects client updates whose settled structural change would produce
 * ambiguous sibling heading paths under the current heading-path-addressability
 * model (see `SectionRef.headingKey(...)`): two same-parent siblings with
 * matching heading text at the same level. Rejecting at ingress keeps the
 * broken shape out of proposal materialization AND out of quiescence-time
 * normalization, so `normalizeQuiescedStructure()` remains an internal
 * correctness check rather than the normal discovery point for expected
 * invalid edits.
 *
 * This helper is PURE: it consumes the touched fragment set, the effective
 * live section layout (`resolveLiveSectionLayout(...)`), each touched
 * fragment's post-update markdown, and the shared structural classifier
 * (`classifyStructuralChange(...)`). It never touches Y.Doc or proposal state
 * — the caller (`processArbitratedClientUpdate(...)` acceptance gate) uses the
 * returned rejection groups to drive the pre-update snapshot restore and the
 * origin-only `section:edit-rejected` app event.
 *
 * The rejection group model is the smallest closed accept/reject unit for one
 * structural operation. For heading-rename / heading-level-change today that
 * is the single fragment carrying the renamed heading; for section-split /
 * root-split it is the fragment carrying the split (its new children do not
 * exist as live fragments yet). Grouping matters because partially accepting
 * one structural op would leave the DocSession with topology whose meaning is
 * different from what the author saw.
 *
 * Scope discipline: this file adds a live-edit-only validation affordance and
 * MUST NOT be turned into a canonical skeleton invariant. `DocumentSkeleton`
 * still supports duplicate sibling headings at the model level; the ingress
 * gate merely refuses to route into that ambiguous state via CRDT.
 */

import { classifyStructuralChange, type StructuralChange } from "./structural-change.js";
import { headingsEqual } from "../storage/document-skeleton.js";
import type { LiveSectionLayoutEntry } from "./live-section-layout.js";
import type { FragmentContent } from "../storage/section-formatting.js";
import type { HeadingLevel } from "../types/shared.js";

export interface StructuralValidationRejectedFragment {
  fragmentKey: string;
  headingPath: string[];
  heading: string;
}

export interface StructuralValidationRejectionGroup {
  fragmentKeys: string[];
  reasonCode: "duplicate-sibling-heading";
  affectedFragments: StructuralValidationRejectedFragment[];
  title: string;
  message: string;
  whatHappened: string;
  whyRejected: string;
  serverAction: string;
  guidance: string;
}

export interface StructuralValidationInput {
  touchedFragmentKeys: Iterable<string>;
  layout: readonly LiveSectionLayoutEntry[];
  readPostUpdateMarkdown: (fragmentKey: string) => FragmentContent;
}

export interface StructuralValidationResult {
  rejectionGroups: StructuralValidationRejectionGroup[];
}

interface SiblingBucketEntry {
  heading: string;
  headingLevel: HeadingLevel;
  fragmentKey: string;
}

/**
 * Validate every touched fragment's settled structural change against the
 * current effective layout and reject fragments whose rename / split / etc.
 * would materialize into a duplicate sibling heading path at the same level.
 */
export function validateLiveEditForDuplicateSiblingHeadings(
  input: StructuralValidationInput,
): StructuralValidationResult {
  const layoutByFragmentKey = new Map<string, LiveSectionLayoutEntry>();
  for (const entry of input.layout) {
    layoutByFragmentKey.set(entry.fragmentKey, entry);
  }
  const siblingsByParentKey = buildSiblingBuckets(input.layout);
  const rejectionGroups: StructuralValidationRejectionGroup[] = [];

  for (const fragmentKey of input.touchedFragmentKeys) {
    const entry = layoutByFragmentKey.get(fragmentKey);
    if (!entry) continue;
    const markdown = input.readPostUpdateMarkdown(fragmentKey);
    const change = classifyStructuralChange(markdown, {
      headingPath: entry.headingPath,
      heading: entry.heading,
      headingLevel: entry.headingLevel,
    });
    const rejection = detectRejection(fragmentKey, entry, change, siblingsByParentKey);
    if (rejection) rejectionGroups.push(rejection);
  }

  return { rejectionGroups };
}

function parentKey(parentHeadingPath: readonly string[]): string {
  return parentHeadingPath.map((seg) => seg.toLowerCase()).join(">>");
}

function buildSiblingBuckets(
  layout: readonly LiveSectionLayoutEntry[],
): Map<string, SiblingBucketEntry[]> {
  const buckets = new Map<string, SiblingBucketEntry[]>();
  for (const entry of layout) {
    if (entry.headingPath.length === 0) continue;
    const parent = entry.headingPath.slice(0, -1);
    const key = parentKey(parent);
    const list = buckets.get(key) ?? [];
    list.push({ heading: entry.heading, headingLevel: entry.headingLevel, fragmentKey: entry.fragmentKey });
    buckets.set(key, list);
  }
  return buckets;
}

function findSiblingCollision(
  siblings: SiblingBucketEntry[] | undefined,
  ownFragmentKey: string | null,
  proposedHeading: string,
  proposedHeadingLevel: HeadingLevel,
): SiblingBucketEntry | null {
  if (!siblings) return null;
  for (const sibling of siblings) {
    if (sibling.fragmentKey === ownFragmentKey) continue;
    if (sibling.headingLevel !== proposedHeadingLevel) continue;
    if (!headingsEqual(sibling.heading, proposedHeading)) continue;
    return sibling;
  }
  return null;
}

function buildDuplicateSiblingRejection(
  fragmentKey: string,
  entry: LiveSectionLayoutEntry,
  proposedHeading: string,
  proposedHeadingLevel: HeadingLevel,
  parentHeadingPath: readonly string[],
  conflict: SiblingBucketEntry,
): StructuralValidationRejectionGroup {
  const parentLabel = parentHeadingPath.length === 0 ? "the document root" : `“${parentHeadingPath.join(" > ")}”`;
  return {
    fragmentKeys: [fragmentKey],
    reasonCode: "duplicate-sibling-heading",
    affectedFragments: [
      {
        fragmentKey,
        headingPath: [...entry.headingPath],
        heading: entry.heading,
      },
    ],
    title: "Duplicate heading rejected",
    message: `Two sections under ${parentLabel} would end up with the heading “${proposedHeading}”.`,
    whatHappened:
      `Your edit would rename the section to “${proposedHeading}” at heading level ${proposedHeadingLevel}, ` +
      `but a sibling section already uses that same heading (fragment ${conflict.fragmentKey}).`,
    whyRejected:
      "Two sibling sections cannot share the same heading — the app would no longer be able to tell " +
      "them apart, and one would silently hide the other when the document is refreshed.",
    serverAction: "Your edit was reverted to the last accepted state and no proposal claim was recorded.",
    guidance:
      "Use a distinct heading, rename the other sibling first, or move one of the sections under a " +
      "different parent before making this change.",
  };
}

function detectRejection(
  fragmentKey: string,
  entry: LiveSectionLayoutEntry,
  change: StructuralChange,
  siblingsByParentKey: Map<string, SiblingBucketEntry[]>,
): StructuralValidationRejectionGroup | null {
  if (change.kind === "heading-rename" || change.kind === "heading-level-change") {
    const proposedHeading = change.kind === "heading-rename" ? change.newHeading : change.newHeading;
    const proposedHeadingLevel = change.kind === "heading-rename" ? change.headingLevel : change.newHeadingLevel;
    const parent = entry.headingPath.slice(0, -1);
    const conflict = findSiblingCollision(
      siblingsByParentKey.get(parentKey(parent)),
      entry.fragmentKey,
      proposedHeading,
      proposedHeadingLevel,
    );
    if (conflict) {
      return buildDuplicateSiblingRejection(fragmentKey, entry, proposedHeading, proposedHeadingLevel, parent, conflict);
    }
    return null;
  }

  if (change.kind === "section-split") {
    // Every split child sits under this fragment's parent at the parsed level.
    // A duplicate exists if the split's first heading collides with an existing
    // sibling (the surviving section's identity keeps its own slot) OR if any
    // split subsection collides pairwise with another entry appearing in the
    // same parent list. The smallest closed group is the fragment carrying the
    // split — its new children do not exist as live fragments yet.
    const parent = entry.headingPath.slice(0, -1);
    const parentSiblings = siblingsByParentKey.get(parentKey(parent));
    // Track headings the split itself introduces at each parent's level so the
    // second-and-later duplicates within the split payload also reject cleanly.
    const seenInThisSplit = new Set<string>();
    const splitEntries = [
      ...change.before,
      {
        headingPath: [change.survivor.heading],
        heading: change.survivor.heading,
        headingLevel: change.survivor.headingLevel,
      },
      ...change.after,
    ];
    for (const section of splitEntries) {
      // Only top-of-split entries land as new siblings at this parent's level;
      // deeper nested split entries have their own parent inside the split.
      if (section.headingPath.length !== 1) continue;
      const proposedHeading = section.heading;
      const proposedHeadingLevel = section.headingLevel;
      const conflict = findSiblingCollision(
        parentSiblings,
        entry.fragmentKey,
        proposedHeading,
        proposedHeadingLevel,
      );
      if (conflict) {
        return buildDuplicateSiblingRejection(
          fragmentKey,
          entry,
          proposedHeading,
          proposedHeadingLevel,
          parent,
          conflict,
        );
      }
      const key = `${proposedHeadingLevel}::${proposedHeading.toLowerCase()}`;
      if (seenInThisSplit.has(key)) {
        return buildDuplicateSiblingRejection(
          fragmentKey,
          entry,
          proposedHeading,
          proposedHeadingLevel,
          parent,
          { heading: proposedHeading, headingLevel: proposedHeadingLevel, fragmentKey },
        );
      }
      seenInThisSplit.add(key);
    }
    return null;
  }

  if (change.kind === "root-split") {
    // Root split promotes headings from inside the BFH section to real top-level
    // sections. Duplicate check runs against the document's root siblings.
    const rootSiblings = siblingsByParentKey.get(parentKey([]));
    const seenInThisSplit = new Set<string>();
    for (const section of change.sections) {
      if (section.headingPath.length !== 1) continue;
      const proposedHeading = section.heading;
      const proposedHeadingLevel = section.headingLevel;
      const conflict = findSiblingCollision(
        rootSiblings,
        entry.fragmentKey,
        proposedHeading,
        proposedHeadingLevel,
      );
      if (conflict) {
        return buildDuplicateSiblingRejection(
          fragmentKey,
          entry,
          proposedHeading,
          proposedHeadingLevel,
          [],
          conflict,
        );
      }
      const key = `${proposedHeadingLevel}::${proposedHeading.toLowerCase()}`;
      if (seenInThisSplit.has(key)) {
        return buildDuplicateSiblingRejection(
          fragmentKey,
          entry,
          proposedHeading,
          proposedHeadingLevel,
          [],
          { heading: proposedHeading, headingLevel: proposedHeadingLevel, fragmentKey },
        );
      }
      seenInThisSplit.add(key);
    }
    return null;
  }

  // heading-deletion / heading-relocated / clean cannot introduce a new
  // sibling heading path collision (relocated preserves the heading text; the
  // deletion path removes a heading rather than adding one).
  return null;
}
