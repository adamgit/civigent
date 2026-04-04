import { readFile } from "node:fs/promises";
import { getContentRoot, getSnapshotRoot } from "./data-root.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "./path-utils.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import { prependHeading } from "./section-formatting.js";
import { readEnvVar } from "../env.js";

// Re-export error classes from ContentLayer (callers import from here)
export { DocumentNotFoundError, DocumentAssemblyError } from "./content-layer.js";
export { prependHeading } from "./section-formatting.js";

function snapshotReadsEnabled(): boolean {
  const raw = readEnvVar("KS_SNAPSHOT_ENABLED", "true").toLowerCase();
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
 * Prepend heading lines to body-only content for all headed sections.
 *
 * Takes a section list and a Map<headingKey, string> of body-only content,
 * returns a new Map<headingKey, string> with "## Heading\n\n" prepended to each
 * non-root entry. Root entries (level=0, heading="") are passed through unchanged.
 */
export function prependHeadings(
  sections: Array<{ heading: string; level: number; headingPath: string[] }>,
  bodyMap: Map<string, string>,
): Map<string, string> {
  const result = new Map(bodyMap);
  for (const { heading, level, headingPath } of sections) {
    const isBeforeFirstHeading = level === 0 && heading === "";
    if (isBeforeFirstHeading) continue;
    const key = SectionRef.headingKey(headingPath);
    const body = result.get(key);
    if (body == null) continue;
    result.set(key, prependHeading(body, level, heading));
  }
  return result;
}
