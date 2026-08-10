import { classifyStructuralChange, type StructuralChange } from "./structural-change.js";
import { HeadingLevel } from "../types/shared.js";
import type { LiveSectionLayoutEntry } from "./live-section-layout.js";
import { stripHeadingFromFragment, type FragmentContent } from "../storage/section-formatting.js";
import type {
  LiveSectionSnapshot,
  LiveSectionsSnapshotResult,
  AwaitingStructuralReconciliationSection,
} from "./crdt-proposal-generator.js";

export interface CapturedLiveFragment {
  identity: LiveSectionLayoutEntry;
  content: FragmentContent;
  change: StructuralChange;
}

export function captureLiveFragments(
  layout: readonly LiveSectionLayoutEntry[],
  readFragmentString: (fragmentKey: string) => FragmentContent,
): CapturedLiveFragment[] {
  return layout.map((identity) => {
    const content = readFragmentString(identity.fragmentKey);
    return {
      identity,
      content,
      change: classifyStructuralChange(content, {
        headingPath: identity.headingPath,
        heading: identity.heading,
        headingLevel: identity.headingLevel,
      }),
    };
  });
}

export function partitionCapturedLiveFragments(
  captured: readonly CapturedLiveFragment[],
): LiveSectionsSnapshotResult {
  const materializableBodies: LiveSectionSnapshot[] = [];
  const awaitingStructuralReconciliation: AwaitingStructuralReconciliationSection[] = [];
  for (const { identity, content, change } of captured) {
    if (identity.headingPath.length === 0) {
      materializableBodies.push({
        headingPath: [...identity.headingPath],
        heading: identity.heading,
        headingLevel: identity.headingLevel,
        body: stripHeadingFromFragment(content, HeadingLevel.beforeFirstHeading),
        fragmentKey: identity.fragmentKey,
      });
      continue;
    }
    if (change.kind !== "clean") {
      awaitingStructuralReconciliation.push({
        fragmentKey: identity.fragmentKey,
        headingPath: [...identity.headingPath],
        heading: identity.heading,
        headingLevel: identity.headingLevel,
      });
      continue;
    }
    materializableBodies.push({
      headingPath: [...identity.headingPath],
      heading: identity.heading,
      headingLevel: identity.headingLevel,
      body: stripHeadingFromFragment(content, identity.headingLevel),
      fragmentKey: identity.fragmentKey,
    });
  }
  return { materializableBodies, awaitingStructuralReconciliation };
}
