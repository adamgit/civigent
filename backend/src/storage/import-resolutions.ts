/**
 * import-resolutions.ts — Salvage algorithms for rejected staging files.
 *
 * Each entry in IMPORT_RESOLUTIONS is a self-contained miniature: id, dropdown
 * label, an applies() predicate, and an apply() rewrite of the markdown.
 * Adding or deleting an algorithm is editing this list — nothing else should
 * switch on resolution ids. Scan uses applies() to populate the preview
 * dropdown; resolve-file uses apply() to rewrite the staged bytes.
 *
 * These exist because assembled exports of historically damaged documents
 * (legacy crash-recovery duplicate headings) are otherwise un-importable.
 * They are not a general markdown rewriter.
 */

import { SectionRef } from "../domain/section-ref.js";
import { parseDocumentMarkdown, type ParsedSection } from "./markdown-sections.js";

export class ImportResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportResolutionError";
  }
}

export interface DuplicateBodyConflictCopy {
  readonly index: number;
  readonly body: string;
}

export interface DuplicateBodyConflict {
  readonly heading_path: string[];
  readonly label: string;
  readonly copies: readonly DuplicateBodyConflictCopy[];
}

export interface DuplicateBodyConflictPreview {
  readonly conflicts: readonly DuplicateBodyConflict[];
}

export interface ImportResolutionOption {
  readonly id: string;
  readonly label: string;
  applies(markdown: string): boolean;
  apply(markdown: string, params?: unknown): string;
  preview?(markdown: string): DuplicateBodyConflictPreview;
}

function headingPathKey(section: ParsedSection): string {
  return SectionRef.headingKey([...section.headingPath]);
}

function headingPathLabel(section: ParsedSection): string {
  return section.headingPath.length === 0
    ? "(before first heading)"
    : section.headingPath.join(" > ");
}

function isEmptyBody(section: ParsedSection): boolean {
  return (section.body as string).trim().length === 0;
}

function serializeParsedSections(sections: readonly ParsedSection[]): string {
  const parts = sections.map((section) => {
    if (section.headingPath.length === 0) return section.body as string;
    const headingLine = `${"#".repeat(section.headingLevel)} ${section.heading}`;
    const body = (section.body as string).trim();
    return body.length > 0 ? `${headingLine}\n\n${body}` : headingLine;
  });
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function groupByHeadingPath(sections: readonly ParsedSection[]): Map<string, ParsedSection[]> {
  const groups = new Map<string, ParsedSection[]>();
  for (const section of sections) {
    const key = headingPathKey(section);
    const group = groups.get(key);
    if (group) group.push(section);
    else groups.set(key, [section]);
  }
  return groups;
}

export function findDuplicateHeadingPathLabels(sections: readonly ParsedSection[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  const labeled = new Set<string>();
  for (const section of sections) {
    const key = headingPathKey(section);
    if (seen.has(key)) {
      if (!labeled.has(key)) {
        labels.push(headingPathLabel(section));
        labeled.add(key);
      }
    } else {
      seen.add(key);
    }
  }
  return labels;
}

function dropEmptyDuplicates(sections: readonly ParsedSection[]): ParsedSection[] {
  const groups = groupByHeadingPath(sections);
  const drop = new Set<ParsedSection>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const nonempty = group.filter((section) => !isEmptyBody(section));
    const empty = group.filter((section) => isEmptyBody(section));
    if (nonempty.length > 0) {
      for (const section of empty) drop.add(section);
    } else {
      for (const section of empty.slice(1)) drop.add(section);
    }
  }
  return sections.filter((section) => !drop.has(section));
}

function trimmedBody(section: ParsedSection): string {
  return (section.body as string).trim();
}

/**
 * Collapse a duplicate heading-path group when every nonempty body is the same
 * (trimmed). Keep the first nonempty copy in document order — or the first
 * empty copy if the whole group is empty — and drop the rest. Groups whose
 * nonempty bodies disagree are left untouched.
 */
function collapseIdenticalDuplicates(sections: readonly ParsedSection[]): ParsedSection[] {
  const groups = groupByHeadingPath(sections);
  const drop = new Set<ParsedSection>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const nonempty = group.filter((section) => !isEmptyBody(section));
    if (nonempty.length === 0) {
      for (const section of group.slice(1)) drop.add(section);
      continue;
    }
    const canonical = trimmedBody(nonempty[0]);
    if (!nonempty.every((section) => trimmedBody(section) === canonical)) continue;
    const keep = nonempty[0];
    for (const section of group) {
      if (section !== keep) drop.add(section);
    }
  }
  return sections.filter((section) => !drop.has(section));
}

function hasUniqueHeadingPaths(sections: readonly ParsedSection[]): boolean {
  return findDuplicateHeadingPathLabels(sections).length === 0;
}

function listDisagreeingDuplicateGroups(sections: readonly ParsedSection[]): Array<{
  headingPath: string[];
  label: string;
  nonempty: ParsedSection[];
}> {
  const groups = groupByHeadingPath(sections);
  const result: Array<{
    headingPath: string[];
    label: string;
    nonempty: ParsedSection[];
  }> = [];
  for (const group of groups.values()) {
    const nonempty = group.filter((section) => !isEmptyBody(section));
    if (nonempty.length < 2) continue;
    const canonical = trimmedBody(nonempty[0]);
    if (nonempty.every((section) => trimmedBody(section) === canonical)) continue;
    result.push({
      headingPath: nonempty[0].headingPath,
      label: headingPathLabel(nonempty[0]),
      nonempty,
    });
  }
  return result;
}

function duplicateBodyConflictPreview(markdown: string): DuplicateBodyConflictPreview {
  return {
    conflicts: listDisagreeingDuplicateGroups(parseDocumentMarkdown(markdown)).map((entry) => ({
      heading_path: [...entry.headingPath],
      label: entry.label,
      copies: entry.nonempty.map((section, index) => ({
        index,
        body: section.body as string,
      })),
    })),
  };
}

function parseKeepChoices(
  params: unknown,
  conflicts: ReturnType<typeof listDisagreeingDuplicateGroups>,
): Map<string, number> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ImportResolutionError("This repair needs a choice of which duplicate body to keep.");
  }
  const keep = (params as { keep?: unknown }).keep;
  if (!Array.isArray(keep) || keep.length === 0) {
    throw new ImportResolutionError("This repair needs a choice of which duplicate body to keep.");
  }

  const byKey = new Map(conflicts.map((entry) => [headingPathKey(entry.nonempty[0]), entry]));
  const choices = new Map<string, number>();
  for (const item of keep) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ImportResolutionError("Each keep choice must name a heading_path and index.");
    }
    const headingPath = (item as { heading_path?: unknown }).heading_path;
    const index = (item as { index?: unknown }).index;
    if (!Array.isArray(headingPath) || headingPath.some((segment) => typeof segment !== "string")) {
      throw new ImportResolutionError("keep.heading_path must be an array of strings.");
    }
    if (typeof index !== "number" || !Number.isInteger(index)) {
      throw new ImportResolutionError("keep.index must be an integer.");
    }
    const key = SectionRef.headingKey(headingPath);
    const conflict = byKey.get(key);
    if (!conflict) {
      throw new ImportResolutionError(`No disagreeing duplicate heading at ${headingPath.join(" > ") || "(before first heading)"}.`);
    }
    if (index < 0 || index >= conflict.nonempty.length) {
      throw new ImportResolutionError(`keep.index ${index} is out of range for ${conflict.label}.`);
    }
    choices.set(key, index);
  }
  if (choices.size !== conflicts.length) {
    throw new ImportResolutionError("Choose a body for every heading that has disagreeing duplicates.");
  }
  return choices;
}

function keepChosenDuplicateBodies(
  sections: readonly ParsedSection[],
  choices: Map<string, number>,
): ParsedSection[] {
  const groups = groupByHeadingPath(sections);
  const drop = new Set<ParsedSection>();
  for (const [key, group] of groups) {
    const chosenIndex = choices.get(key);
    if (chosenIndex === undefined) continue;
    const nonempty = group.filter((section) => !isEmptyBody(section));
    const keep = nonempty[chosenIndex];
    for (const section of group) {
      if (section !== keep) drop.add(section);
    }
  }
  return sections.filter((section) => !drop.has(section));
}

/**
 * Legacy crash recovery sometimes emitted the same heading twice: an empty
 * stub followed by the real section (or several empty stubs). Dropping the
 * empty extras restores a unique heading path without inventing content.
 */
export const discardEmptyDuplicateHeadings: ImportResolutionOption = {
  id: "discard-empty-duplicate-headings",
  label: "Discard empty duplicate headings",
  applies(markdown: string): boolean {
    const parsed = parseDocumentMarkdown(markdown);
    if (hasUniqueHeadingPaths(parsed)) return false;
    const next = dropEmptyDuplicates(parsed);
    return next.length < parsed.length && hasUniqueHeadingPaths(next);
  },
  apply(markdown: string): string {
    return serializeParsedSections(dropEmptyDuplicates(parseDocumentMarkdown(markdown)));
  },
};

/**
 * Same heading path, same body (or empty stubs next to that body). Keep the
 * first nonempty copy and drop the extras. Does not require the whole file to
 * become unique — groups whose bodies disagree are left for a later repair.
 */
export const keepFirstIdenticalDuplicateHeadings: ImportResolutionOption = {
  id: "keep-first-identical-duplicate-headings",
  label: "Keep first of identical duplicate headings",
  applies(markdown: string): boolean {
    const parsed = parseDocumentMarkdown(markdown);
    if (hasUniqueHeadingPaths(parsed)) return false;
    const next = collapseIdenticalDuplicates(parsed);
    return next.length < parsed.length;
  },
  apply(markdown: string): string {
    return serializeParsedSections(collapseIdenticalDuplicates(parseDocumentMarkdown(markdown)));
  },
};

/**
 * Same heading path, different bodies. The UI shows the copies and the caller
 * says which index to keep. Empty stubs in that group are dropped with the
 * losers. Other heading paths are left alone.
 */
export const chooseDuplicateHeadingBody: ImportResolutionOption = {
  id: "choose-duplicate-heading-body",
  label: "Choose which duplicate body to keep",
  applies(markdown: string): boolean {
    return listDisagreeingDuplicateGroups(parseDocumentMarkdown(markdown)).length > 0;
  },
  preview(markdown: string): DuplicateBodyConflictPreview {
    return duplicateBodyConflictPreview(markdown);
  },
  apply(markdown: string, params?: unknown): string {
    const parsed = parseDocumentMarkdown(markdown);
    const conflicts = listDisagreeingDuplicateGroups(parsed);
    const choices = parseKeepChoices(params, conflicts);
    return serializeParsedSections(keepChosenDuplicateBodies(parsed, choices));
  },
};

export const IMPORT_RESOLUTIONS: readonly ImportResolutionOption[] = [
  discardEmptyDuplicateHeadings,
  keepFirstIdenticalDuplicateHeadings,
  chooseDuplicateHeadingBody,
];

export function resolutionsForMarkdown(markdown: string): ImportResolutionOption[] {
  return IMPORT_RESOLUTIONS.filter((resolution) => resolution.applies(markdown));
}

export function applyImportResolution(
  markdown: string,
  resolutionId: string,
  params?: unknown,
): string {
  const resolution = IMPORT_RESOLUTIONS.find((option) => option.id === resolutionId);
  if (!resolution) {
    throw new ImportResolutionError(`Unknown import resolution: ${resolutionId}`);
  }
  if (!resolution.applies(markdown)) {
    throw new ImportResolutionError(`Resolution "${resolution.label}" does not apply to this file.`);
  }
  return resolution.apply(markdown, params);
}
