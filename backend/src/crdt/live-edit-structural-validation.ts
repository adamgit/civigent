/**
 * CRDT live-edit structural validation — the first ingress rejection rule.
 *
 * Detects client updates whose settled structural change would INTRODUCE an
 * ambiguous sibling heading path under the current heading-path-addressability
 * model (see `SectionRef.headingKey(...)`): two same-parent siblings with
 * matching heading text at the same level. Rejecting at ingress keeps the
 * broken shape out of proposal materialization AND out of quiescence-time
 * normalization, so `normalizeQuiescedStructure()` remains an internal
 * correctness check rather than the normal discovery point for expected
 * invalid edits.
 *
 * Validation is a collision-set DELTA, not a post-state property check: for
 * each semantically changed fragment the validator computes the collision set
 * of the pre-update markdown and of the post-update markdown (each classified
 * against the same effective layout identity) and rejects only collisions
 * present post-update that were absent pre-update. A collision already present
 * before the edit is never attributed to the edit — a document carrying an
 * existing duplicate heading stays editable, so the duplicate can be repaired,
 * renamed away, or left untouched by unrelated content changes.
 *
 * Each collision has a stable identity derived from the normalized parent
 * path, the heading level, the normalized heading text, and the participating
 * fragment identities (layout fragments by key; entries a fragment's own
 * unsettled split introduces by key plus per-heading occurrence ordinal, so
 * the identity survives unrelated edits inside the same fragment).
 *
 * This helper is PURE: it consumes the touched fragment set, the effective
 * live section layout (`resolveLiveSectionLayout(...)`), each touched
 * fragment's pre- and post-update markdown, and the shared structural
 * classifier (`classifyStructuralChange(...)`). It never touches Y.Doc or
 * proposal state — the caller (`processArbitratedClientUpdate(...)` acceptance
 * gate) uses the returned rejection groups to drive the pre-update snapshot
 * restore and the origin-only `section:edit-rejected` app event.
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
  readPreUpdateMarkdown: (fragmentKey: string) => FragmentContent;
  readPostUpdateMarkdown: (fragmentKey: string) => FragmentContent;
}

export interface StructuralValidationResult {
  rejectionGroups: StructuralValidationRejectionGroup[];
}

interface ProposedSiblingEntry {
  parentHeadingPath: readonly string[];
  heading: string;
  headingLevel: HeadingLevel;
}

interface CollisionDescriptor {
  identity: string;
  parentHeadingPath: readonly string[];
  heading: string;
  headingLevel: HeadingLevel;
  otherFragmentKeys: string[];
}

/**
 * Validate every semantically changed fragment's settled structural change by
 * comparing the pre-update and post-update collision sets against the current
 * effective layout, rejecting a fragment only when its change INTRODUCES a
 * duplicate sibling heading path that the pre-update state did not have.
 */
export function validateLiveEditForDuplicateSiblingHeadings(
  input: StructuralValidationInput,
): StructuralValidationResult {
  const layoutByFragmentKey = new Map<string, LiveSectionLayoutEntry>();
  for (const entry of input.layout) {
    layoutByFragmentKey.set(entry.fragmentKey, entry);
  }
  const rejectionGroups: StructuralValidationRejectionGroup[] = [];

  for (const fragmentKey of input.touchedFragmentKeys) {
    const entry = layoutByFragmentKey.get(fragmentKey);
    if (!entry) continue;
    const identity = {
      headingPath: entry.headingPath,
      heading: entry.heading,
      headingLevel: entry.headingLevel,
    };
    const preChange = classifyStructuralChange(input.readPreUpdateMarkdown(fragmentKey), identity);
    const postChange = classifyStructuralChange(input.readPostUpdateMarkdown(fragmentKey), identity);
    const preCollisions = collectCollisions(
      fragmentKey,
      contributionsForChange(entry, preChange),
      input.layout,
    );
    const postCollisions = collectCollisions(
      fragmentKey,
      contributionsForChange(entry, postChange),
      input.layout,
    );
    const introduced = [...postCollisions.values()].filter(
      (collision) => !preCollisions.has(collision.identity),
    );
    if (introduced.length > 0) {
      rejectionGroups.push(buildRejectionGroup(fragmentKey, entry, introduced));
    }
  }

  return { rejectionGroups };
}

function parentKeyOf(parentHeadingPath: readonly string[]): string {
  return parentHeadingPath.map((seg) => seg.toLowerCase()).join(">>");
}

function collisionGroupKey(
  parentHeadingPath: readonly string[],
  headingLevel: HeadingLevel,
  heading: string,
): string {
  return `${parentKeyOf(parentHeadingPath)}::${headingLevel}::${heading.toLowerCase()}`;
}

/**
 * The sibling entries this fragment's settled structural change would place in
 * the document, addressed by parent heading path. Only top-of-split entries
 * land as new siblings at the fragment's parent; deeper nested split entries
 * have their own parent inside the split.
 */
function contributionsForChange(
  entry: LiveSectionLayoutEntry,
  change: StructuralChange,
): ProposedSiblingEntry[] {
  const parent = entry.headingPath.slice(0, -1);
  switch (change.kind) {
    case "clean":
    case "heading-relocated":
      if (entry.headingPath.length === 0) return [];
      return [{ parentHeadingPath: parent, heading: entry.heading, headingLevel: entry.headingLevel }];
    case "heading-rename":
      return [{ parentHeadingPath: parent, heading: change.newHeading, headingLevel: change.headingLevel }];
    case "heading-level-change":
      return [{ parentHeadingPath: parent, heading: change.newHeading, headingLevel: change.newHeadingLevel }];
    case "heading-deletion":
      return [];
    case "section-split": {
      const splitEntries = [
        ...change.before,
        {
          headingPath: [change.survivor.heading],
          heading: change.survivor.heading,
          headingLevel: change.survivor.headingLevel,
        },
        ...change.after,
      ];
      const out: ProposedSiblingEntry[] = [];
      for (const section of splitEntries) {
        if (section.headingPath.length !== 1) continue;
        out.push({ parentHeadingPath: parent, heading: section.heading, headingLevel: section.headingLevel });
      }
      return out;
    }
    case "root-split": {
      const out: ProposedSiblingEntry[] = [];
      for (const section of change.sections) {
        if (section.headingPath.length !== 1) continue;
        out.push({ parentHeadingPath: [], heading: section.heading, headingLevel: section.headingLevel });
      }
      return out;
    }
  }
}

/**
 * Compute the collision set of one fragment's projected state: its proposed
 * sibling entries placed into the layout roster (all other fragments at their
 * settled layout identities). A collision is any same-parent group of ≥2
 * participants sharing heading level and normalized heading text that includes
 * at least one of this fragment's own entries. Identity participants: layout
 * fragments by key; this fragment's own entries by key plus per-heading
 * occurrence ordinal, so unrelated edits inside the fragment cannot shift an
 * existing collision's identity.
 */
function collectCollisions(
  fragmentKey: string,
  contributions: ProposedSiblingEntry[],
  layout: readonly LiveSectionLayoutEntry[],
): Map<string, CollisionDescriptor> {
  const collisions = new Map<string, CollisionDescriptor>();
  if (contributions.length === 0) return collisions;

  interface GroupInfo {
    parentHeadingPath: readonly string[];
    heading: string;
    headingLevel: HeadingLevel;
    ownParticipantIds: string[];
    otherFragmentKeys: string[];
  }
  const groups = new Map<string, GroupInfo>();
  for (const contribution of contributions) {
    const key = collisionGroupKey(
      contribution.parentHeadingPath,
      contribution.headingLevel,
      contribution.heading,
    );
    const group = groups.get(key) ?? {
      parentHeadingPath: contribution.parentHeadingPath,
      heading: contribution.heading,
      headingLevel: contribution.headingLevel,
      ownParticipantIds: [],
      otherFragmentKeys: [],
    };
    group.ownParticipantIds.push(`${fragmentKey}#${group.ownParticipantIds.length}`);
    groups.set(key, group);
  }

  for (const entry of layout) {
    if (entry.fragmentKey === fragmentKey) continue;
    if (entry.headingPath.length === 0) continue;
    const parent = entry.headingPath.slice(0, -1);
    const key = collisionGroupKey(parent, entry.headingLevel, entry.heading);
    const group = groups.get(key);
    if (group) group.otherFragmentKeys.push(entry.fragmentKey);
  }

  for (const [key, group] of groups) {
    if (group.ownParticipantIds.length + group.otherFragmentKeys.length < 2) continue;
    const participants = [...group.ownParticipantIds, ...group.otherFragmentKeys].sort();
    const identity = `${key}::${participants.join(",")}`;
    collisions.set(identity, {
      identity,
      parentHeadingPath: group.parentHeadingPath,
      heading: group.heading,
      headingLevel: group.headingLevel,
      otherFragmentKeys: [...group.otherFragmentKeys],
    });
  }
  return collisions;
}

function buildRejectionGroup(
  fragmentKey: string,
  entry: LiveSectionLayoutEntry,
  introduced: CollisionDescriptor[],
): StructuralValidationRejectionGroup {
  const first = introduced[0]!;
  const parentLabel =
    first.parentHeadingPath.length === 0 ? "the document root" : `“${first.parentHeadingPath.join(" > ")}”`;
  const conflictFragmentKey = first.otherFragmentKeys[0] ?? fragmentKey;
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
    message: `Two sections under ${parentLabel} would end up with the heading “${first.heading}”.`,
    whatHappened:
      `Your edit would give a section the heading “${first.heading}” at heading level ${first.headingLevel}, ` +
      `but that heading would collide with a sibling section (fragment ${conflictFragmentKey}).`,
    whyRejected:
      "Two sibling sections cannot share the same heading — the app would no longer be able to tell " +
      "them apart, and one would silently hide the other when the document is refreshed.",
    serverAction: "Your edit was reverted to the last accepted state and no proposal claim was recorded.",
    guidance:
      "Use a distinct heading, rename the other sibling first, or move one of the sections under a " +
      "different parent before making this change.",
  };
}
