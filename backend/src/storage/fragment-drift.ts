import { BEFORE_FIRST_HEADING_KEY } from "../crdt/ydoc-fragments.js";
import { parseDocumentMarkdown } from "./markdown-sections.js";

export type FragmentDriftState =
  | "clean"
  | "body-dirty"
  | "structural-dirty"
  | "structural-and-body-dirty";

export interface FragmentDriftClassification {
  state: FragmentDriftState;
  structurallyDirty: boolean;
  orphanOnly: boolean;
}

interface ClassifyFragmentDriftArgs {
  fragmentKey: string;
  headingPath: string[];
  markdown: string;
  isAheadOfStaged: boolean;
}

/**
 * Pure structural-drift classifier used by debounced flush and normalization.
 * It does not touch session/store state, and it performs no I/O.
 */
export function classifyFragmentDrift(args: ClassifyFragmentDriftArgs): FragmentDriftClassification {
  const parsed = parseDocumentMarkdown(args.markdown);
  const orphanOnly = isOrphanOnly(args.headingPath, parsed);
  const structurallyDirty = isStructurallyDirty(args.fragmentKey, parsed);

  if (!structurallyDirty && !args.isAheadOfStaged) {
    return { state: "clean", structurallyDirty: false, orphanOnly };
  }
  if (!structurallyDirty && args.isAheadOfStaged) {
    return { state: "body-dirty", structurallyDirty: false, orphanOnly };
  }
  if (structurallyDirty && !args.isAheadOfStaged) {
    return { state: "structural-dirty", structurallyDirty: true, orphanOnly };
  }
  return { state: "structural-and-body-dirty", structurallyDirty: true, orphanOnly };
}

function isStructurallyDirty(
  fragmentKey: string,
  parsed: Array<{ level: number; heading: string }>,
): boolean {
  if (fragmentKey === BEFORE_FIRST_HEADING_KEY) {
    if (parsed.length === 0) return false;
    if (parsed.length === 1 && parsed[0].level === 0 && parsed[0].heading === "") return false;
    return true;
  }

  const topLevelHeadings = parsed.filter((sec) => !(sec.level === 0 && sec.heading === ""));
  return topLevelHeadings.length !== 1;
}

function isOrphanOnly(
  headingPath: string[],
  parsed: Array<{ level: number; heading: string; body: unknown }>,
): boolean {
  if (headingPath.length === 0) return false;
  if (parsed.length !== 1) return false;
  const only = parsed[0];
  if (only.level !== 0 || only.heading !== "") return false;
  return String(only.body ?? "").trim().length > 0;
}
