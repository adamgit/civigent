import { parseDocumentMarkdown } from "../storage/markdown-sections.js";
import { FragmentStore } from "./fragment-store.js";
import type { DocumentFragments } from "./document-fragments.js";

export type NormalizePlan =
  | { kind: "none"; fragmentKey: string }
  | { kind: "root_split"; fragmentKey: string }
  | { kind: "heading_rename"; fragmentKey: string }
  | { kind: "heading_level_change"; fragmentKey: string }
  | { kind: "heading_relocated"; fragmentKey: string }
  | { kind: "section_split"; fragmentKey: string }
  | { kind: "heading_deletion"; fragmentKey: string };

export interface NormalizeApplyOptions {
  broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void;
}

export interface NormalizeResult {
  plan: NormalizePlan;
  changed: boolean;
  createdKeys: string[];
  removedKeys: string[];
}

/**
 * FragmentNormalizer exposes inspectable analyze/apply phases while delegating
 * structural mutation to the existing FragmentStore normalize implementation.
 */
export class FragmentNormalizer {
  analyze(fragmentKey: string, fragments: DocumentFragments): NormalizePlan {
    const entry = fragments.resolveEntryForKey(fragmentKey);
    if (!entry) return { kind: "none", fragmentKey };

    const isBeforeFirstHeading = FragmentStore.isBeforeFirstHeading(entry);
    const parsed = parseDocumentMarkdown(fragments.readFullContent(fragmentKey));
    const realSections = parsed.filter((s) => s.headingPath.length > 0);

    if (isBeforeFirstHeading) {
      return realSections.length > 0
        ? { kind: "root_split", fragmentKey }
        : { kind: "none", fragmentKey };
    }

    if (realSections.length === 0) {
      return { kind: "heading_deletion", fragmentKey };
    }
    if (realSections.length >= 2) {
      return { kind: "section_split", fragmentKey };
    }

    const section = realSections[0];
    if (section.level !== entry.level) return { kind: "heading_level_change", fragmentKey };
    if (section.heading !== entry.heading) return { kind: "heading_rename", fragmentKey };
    if (parsed.length > 1) return { kind: "heading_relocated", fragmentKey };
    return { kind: "none", fragmentKey };
  }

  async apply(
    plan: NormalizePlan,
    fragments: DocumentFragments,
    opts?: NormalizeApplyOptions,
  ): Promise<NormalizeResult> {
    if (plan.kind === "none") {
      return {
        plan,
        changed: false,
        createdKeys: [],
        removedKeys: [],
      };
    }

    const result = await fragments.normalizeStructure(plan.fragmentKey, opts);
    return {
      plan,
      changed: result.changed,
      createdKeys: result.createdKeys,
      removedKeys: result.removedKeys,
    };
  }

  async normalize(
    fragmentKey: string,
    fragments: DocumentFragments,
    opts?: NormalizeApplyOptions,
  ): Promise<NormalizeResult> {
    const plan = this.analyze(fragmentKey, fragments);
    return this.apply(plan, fragments, opts);
  }
}

