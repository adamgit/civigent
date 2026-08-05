import { classifyStructuralChange, type StructuralChange } from "./structural-change.js";
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
        level: identity.level,
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
        level: identity.level,
        body: stripHeadingFromFragment(content, 0),
        fragmentKey: identity.fragmentKey,
      });
      continue;
    }
    if (change.kind !== "clean") {
      awaitingStructuralReconciliation.push({
        fragmentKey: identity.fragmentKey,
        headingPath: [...identity.headingPath],
        heading: identity.heading,
        level: identity.level,
      });
      continue;
    }
    materializableBodies.push({
      headingPath: [...identity.headingPath],
      heading: identity.heading,
      level: identity.level,
      body: stripHeadingFromFragment(content, identity.level),
      fragmentKey: identity.fragmentKey,
    });
  }
  return { materializableBodies, awaitingStructuralReconciliation };
}
