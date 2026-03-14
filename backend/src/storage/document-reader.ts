import { readFile } from "node:fs/promises";
import { getContentRoot, getSnapshotRoot } from "./data-root.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "./path-utils.js";
import { ContentLayer } from "./content-layer.js";
import type { DocumentSkeleton } from "./document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";

// Re-export error classes from ContentLayer (callers import from here)
export { DocumentNotFoundError, DocumentAssemblyError } from "./content-layer.js";

function snapshotReadsEnabled(): boolean {
  const raw = String(process.env.KS_SNAPSHOT_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export async function readAssembledDocument(rawDocPath: string): Promise<string> {
  const contentRoot = getContentRoot();
  // Validate the doc path (throws InvalidDocPathError if bad)
  resolveDocPathUnderContent(contentRoot, rawDocPath);
  if (snapshotReadsEnabled()) {
    try {
      const snapshotPath = resolveDocPathUnderContent(getSnapshotRoot(), rawDocPath);
      return await readFile(snapshotPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Fall back to canonical assembly when snapshot is missing.
    }
  }
  // Delegate assembly to ContentLayer
  const layer = new ContentLayer(contentRoot);
  return layer.readAssembledDocument(rawDocPath);
}

/**
 * Prepend heading lines to body-only content for all non-root sections.
 *
 * Takes a DocumentSkeleton and a Map<headingKey, string> of body-only content,
 * returns a new Map<headingKey, string> with "## Heading\n\n" prepended to each
 * non-root entry. Root entries (level=0, heading="") are passed through unchanged.
 */
export function prependHeadings(
  skeleton: DocumentSkeleton,
  bodyMap: Map<string, string>,
): Map<string, string> {
  const result = new Map(bodyMap);
  skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
    if (isSubSkeleton) return;
    const isRoot = level === 0 && heading === "";
    if (isRoot) return;
    const key = SectionRef.headingKey(headingPath);
    const body = result.get(key);
    if (body == null) return;
    const headingLine = `${"#".repeat(level)} ${heading}`;
    const trimmedBody = body.replace(/^\n+/, "").replace(/\n+$/, "");
    result.set(key, trimmedBody ? `${headingLine}\n\n${trimmedBody}\n` : `${headingLine}\n`);
  });
  return result;
}
