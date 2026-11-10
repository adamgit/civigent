/**
 * CRDT live-edit structural validation — ingress for heading-path uniqueness.
 *
 * A live fragment is an untyped markdown buffer. The only legal question at
 * this door is the write question persist already asks: after this fragment
 * is parsed and mapped onto document heading paths, is every path still
 * uniquely addressable? Occupancy uses `collectParsedHeadingAddresses` and
 * `worsenedDuplicateHeadingAddresses` from heading-addressability — not a
 * classifier projection, not parent+level+text keys.
 *
 * Validation is a multiplicity delta, not a hard post-state refuse: a
 * fragment that already contains a duplicate stays editable so the duplicate
 * can be repaired or left untouched. Reject only when a duplicate address
 * gets worse. Heading-deletion contributes no addresses (merge-and-remove,
 * not a rewrite of `[]`).
 *
 * This helper is PURE: it consumes the touched fragment set, the effective
 * live section layout, and each touched fragment's pre- and post-update
 * markdown. It never touches Y.Doc or proposal state — the caller
 * (`processArbitratedClientUpdate`) uses the returned rejection groups to
 * restore the pre-update snapshot and emit origin-only `section:edit-rejected`.
 *
 * A rejection group is the touched fragments that increased their
 * contribution to one worsened address. A fragment that already occupied
 * that path (and did not add another copy) is not blamed — reverting the
 * aggressor leaves the occupant legal. Two fragments that both move onto
 * the same new path are both blamed.
 *
 * Scope discipline: this file is a live-edit-only affordance and MUST NOT
 * become a canonical skeleton invariant. `DocumentSkeleton` still supports
 * duplicate sibling headings at the model level; uniqueness is the write
 * law in `heading-addressability.ts`.
 */

import type { LiveSectionLayoutEntry } from "./live-section-layout.js";
import { parseDocumentMarkdown } from "../storage/markdown-sections.js";
import type { FragmentContent } from "../storage/section-formatting.js";
import {
  collectParsedHeadingAddresses,
  headingAddressKey,
  headingPathsAddressEqual,
  payloadChildParentPath,
  worsenedDuplicateHeadingAddresses,
} from "../storage/heading-addressability.js";

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

function fragmentHeadingAddresses(
  markdown: string,
  fragmentHeadingPath: readonly string[],
): string[][] {
  return collectParsedHeadingAddresses(
    fragmentHeadingPath.slice(0, -1),
    parseDocumentMarkdown(markdown),
  );
}

function countAddress(paths: readonly (readonly string[])[], addressKey: string): number {
  let count = 0;
  for (const path of paths) {
    if (headingAddressKey(path) === addressKey) count += 1;
  }
  return count;
}

function isDirectLayoutChild(
  entry: LiveSectionLayoutEntry,
  parentPath: readonly string[],
): boolean {
  return (
    entry.headingPath.length === parentPath.length + 1
    && headingPathsAddressEqual(entry.headingPath.slice(0, parentPath.length), parentPath)
  );
}

function noteMover(
  moversByAddressKey: Map<string, Set<string>>,
  moverFragmentKey: string,
  newPath: readonly string[],
): void {
  const addressKey = headingAddressKey(newPath);
  let movers = moversByAddressKey.get(addressKey);
  if (!movers) {
    movers = new Set();
    moversByAddressKey.set(addressKey, movers);
  }
  movers.add(moverFragmentKey);
}

function readdressPrefix(
  postPathByFragmentKey: Map<string, string[]>,
  oldPrefix: readonly string[],
  newPrefix: readonly string[],
  moverFragmentKey: string,
  moversByAddressKey: Map<string, Set<string>>,
): void {
  if (headingPathsAddressEqual(oldPrefix, newPrefix)) return;
  for (const [fragmentKey, path] of [...postPathByFragmentKey.entries()]) {
    if (path.length < oldPrefix.length) continue;
    if (!headingPathsAddressEqual(path.slice(0, oldPrefix.length), oldPrefix)) continue;
    const newPath = [...newPrefix, ...path.slice(oldPrefix.length)];
    postPathByFragmentKey.set(fragmentKey, newPath);
    noteMover(moversByAddressKey, moverFragmentKey, newPath);
  }
}

function nearestPrecedingRealSibling(
  layout: readonly LiveSectionLayoutEntry[],
  touched: LiveSectionLayoutEntry,
): LiveSectionLayoutEntry | null {
  const parentPath = touched.headingPath.slice(0, -1);
  let preceding: LiveSectionLayoutEntry | null = null;
  for (const entry of layout) {
    if (entry.fragmentKey === touched.fragmentKey) break;
    if (isDirectLayoutChild(entry, parentPath)) preceding = entry;
  }
  return preceding;
}

function rightmostRealHeadingDescent(
  layout: readonly LiveSectionLayoutEntry[],
  sibling: LiveSectionLayoutEntry,
): Array<{ headingPath: string[]; headingLevel: number }> {
  const descent: Array<{ headingPath: string[]; headingLevel: number }> = [
    { headingPath: [...sibling.headingPath], headingLevel: sibling.headingLevel },
  ];
  for (;;) {
    const current = descent[descent.length - 1]!;
    const kids = layout.filter((entry) => isDirectLayoutChild(entry, current.headingPath));
    if (kids.length === 0) break;
    const last = kids[kids.length - 1]!;
    descent.push({ headingPath: [...last.headingPath], headingLevel: last.headingLevel });
  }
  return descent;
}

/**
 * Validate every semantically changed fragment by comparing pre-update and
 * post-update heading-path occupancy against the current live layout,
 * rejecting only when the change INTRODUCES or worsens a duplicate address.
 */
export function validateLiveEditForDuplicateSiblingHeadings(
  input: StructuralValidationInput,
): StructuralValidationResult {
  const layoutByFragmentKey = new Map<string, LiveSectionLayoutEntry>();
  for (const entry of input.layout) {
    layoutByFragmentKey.set(entry.fragmentKey, entry);
  }

  const touchedEntries: LiveSectionLayoutEntry[] = [];
  for (const fragmentKey of input.touchedFragmentKeys) {
    const entry = layoutByFragmentKey.get(fragmentKey);
    if (entry) touchedEntries.push(entry);
  }
  const touchedKeys = new Set(touchedEntries.map((entry) => entry.fragmentKey));

  const untouchedHeaded = input.layout.filter(
    (entry) => !touchedKeys.has(entry.fragmentKey) && entry.headingPath.length > 0,
  );
  const preBasePaths = untouchedHeaded.map((entry) => entry.headingPath);

  const postPathByFragmentKey = new Map<string, string[]>();
  for (const entry of untouchedHeaded) {
    postPathByFragmentKey.set(entry.fragmentKey, [...entry.headingPath]);
  }
  const moversByAddressKey = new Map<string, Set<string>>();

  const preByFragment = new Map<string, string[][]>();
  const postByFragment = new Map<string, string[][]>();
  for (const entry of touchedEntries) {
    preByFragment.set(
      entry.fragmentKey,
      fragmentHeadingAddresses(input.readPreUpdateMarkdown(entry.fragmentKey), entry.headingPath),
    );
    postByFragment.set(
      entry.fragmentKey,
      fragmentHeadingAddresses(input.readPostUpdateMarkdown(entry.fragmentKey), entry.headingPath),
    );
  }

  for (const touched of touchedEntries) {
    if (touched.headingPath.length === 0) continue;
    const parsedPost = parseDocumentMarkdown(input.readPostUpdateMarkdown(touched.fragmentKey));
    let headedCount = 0;
    for (const section of parsedPost) {
      if (section.headingPath.length > 0) headedCount += 1;
    }
    const touchedParentPath = touched.headingPath.slice(0, -1);
    const directChildren = input.layout.filter(
      (entry) => !touchedKeys.has(entry.fragmentKey) && isDirectLayoutChild(entry, touched.headingPath),
    );

    if (headedCount >= 2) {
      for (const child of directChildren) {
        const newParentPath = payloadChildParentPath(
          touchedParentPath,
          parsedPost,
          child.headingLevel,
        );
        if (
          newParentPath === null
          || headingPathsAddressEqual(newParentPath, touched.headingPath)
        ) {
          continue;
        }
        const newChildPath = [...newParentPath, child.headingPath[child.headingPath.length - 1]!];
        readdressPrefix(
          postPathByFragmentKey,
          child.headingPath,
          newChildPath,
          touched.fragmentKey,
          moversByAddressKey,
        );
      }
    } else if (headedCount === 0) {
      const preceding = nearestPrecedingRealSibling(input.layout, touched);
      const descent = preceding === null ? [] : rightmostRealHeadingDescent(input.layout, preceding);
      for (const child of directChildren) {
        while (descent.length > 0 && descent[descent.length - 1]!.headingLevel >= child.headingLevel) {
          descent.pop();
        }
        const newParentPath = descent.length === 0
          ? [...touchedParentPath]
          : [...descent[descent.length - 1]!.headingPath];
        const newChildPath = [...newParentPath, child.headingPath[child.headingPath.length - 1]!];
        readdressPrefix(
          postPathByFragmentKey,
          child.headingPath,
          newChildPath,
          touched.fragmentKey,
          moversByAddressKey,
        );
        descent.push({ headingPath: newChildPath, headingLevel: child.headingLevel });
      }
    }
  }

  const preOccupancy = [
    ...preBasePaths,
    ...touchedEntries.flatMap((entry) => preByFragment.get(entry.fragmentKey)!),
  ];
  const postOccupancy = [
    ...postPathByFragmentKey.values(),
    ...touchedEntries.flatMap((entry) => postByFragment.get(entry.fragmentKey)!),
  ];

  const rejectionGroups: StructuralValidationRejectionGroup[] = [];
  for (const duplicate of worsenedDuplicateHeadingAddresses(preOccupancy, postOccupancy)) {
    const participants = touchedEntries.filter((entry) => {
      const preCount = countAddress(preByFragment.get(entry.fragmentKey)!, duplicate.key);
      const postCount = countAddress(postByFragment.get(entry.fragmentKey)!, duplicate.key);
      if (postCount > preCount) return true;
      return moversByAddressKey.get(duplicate.key)?.has(entry.fragmentKey) === true;
    });
    if (participants.length === 0) continue;
    rejectionGroups.push(buildRejectionGroup(participants, duplicate.path));
  }

  return { rejectionGroups };
}

function buildRejectionGroup(
  participants: readonly LiveSectionLayoutEntry[],
  collidingPath: readonly string[],
): StructuralValidationRejectionGroup {
  const heading = collidingPath[collidingPath.length - 1] ?? "";
  const parentHeadingPath = collidingPath.slice(0, -1);
  const parentLabel =
    parentHeadingPath.length === 0 ? "the document root" : `“${parentHeadingPath.join(" > ")}”`;
  const pathLabel = collidingPath.length === 0 ? "the document intro" : collidingPath.join(" > ");
  return {
    fragmentKeys: participants.map((entry) => entry.fragmentKey),
    reasonCode: "duplicate-sibling-heading",
    affectedFragments: participants.map((entry) => ({
      fragmentKey: entry.fragmentKey,
      headingPath: [...entry.headingPath],
      heading: entry.heading,
    })),
    title: "Duplicate heading rejected",
    message: `Two sections under ${parentLabel} would end up with the heading “${heading}”.`,
    whatHappened:
      `Your edit would give two sections the heading path “${pathLabel}”, ` +
      `so the document could no longer address them.`,
    whyRejected:
      "Two sections cannot share the same heading path — the app would no longer be able to tell " +
      "them apart, and one would silently hide the other when the document is refreshed.",
    serverAction: "Your edit was reverted to the last accepted state and no proposal claim was recorded.",
    guidance:
      "Use a distinct heading, rename the other section first, or move one of the sections under a " +
      "different parent before making this change.",
  };
}
