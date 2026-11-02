import { isStructurallyClean } from "./structural-change.js";
import { parseDocumentMarkdown } from "../storage/markdown-sections.js";
import type { LiveSectionLayoutEntry } from "./live-section-layout.js";
import { bodyFromStructuralAssembly, stripHeadingFromFragment, type FragmentContent } from "../storage/section-formatting.js";
import type {
  LiveSectionSnapshot,
  LiveSectionsSnapshotResult,
  AwaitingStructuralReconciliationSection,
} from "./crdt-proposal-generator.js";

export interface CapturedLiveFragment {
  identity: LiveSectionLayoutEntry;
  content: FragmentContent;
  structurallyClean: boolean;
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
      structurallyClean: isStructurallyClean(parseDocumentMarkdown(content), {
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
  for (const { identity, content, structurallyClean } of captured) {
    if (!structurallyClean) {
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
      body: identity.headingPath.length === 0
        ? bodyFromStructuralAssembly(content)
        : stripHeadingFromFragment(content, identity.headingLevel),
      fragmentKey: identity.fragmentKey,
    });
  }
  return { materializableBodies, awaitingStructuralReconciliation };
}
