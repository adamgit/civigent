import { getContentRoot } from "./data-root.js";
import { resolveHeadingPathWithLevel } from "./heading-resolver.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import { prependHeading } from "./section-formatting.js";

// Re-export from ContentLayer (callers import SectionNotFoundError from here)
export { SectionNotFoundError } from "./content-layer.js";

/**
 * Read a single section's body-only content from canonical storage.
 * Delegates to ContentLayer rooted at the canonical content root.
 */
export async function readSection(
  docPath: string,
  headingPath: string[],
): Promise<string> {
  const layer = new ContentLayer(getContentRoot());
  return layer.readSection(new SectionRef(docPath, headingPath));
}

/**
 * Read a section's full content (heading + body) from canonical storage.
 * Headed sections have their heading prepended; before-first-heading sections return body only.
 *
 * Uses ContentLayer for the body read, then prepends the heading line
 * based on the skeleton's heading level.
 */
export async function readSectionWithHeading(
  docPath: string,
  headingPath: string[],
): Promise<string> {
  const layer = new ContentLayer(getContentRoot());
  const ref = new SectionRef(docPath, headingPath);

  // Read body via ContentLayer
  const body = await layer.readSection(ref);

  // For before-first-heading sections, return body only
  if (ref.headingPath.length === 0) return body;

  // Get the heading level from the skeleton
  const { level } = await resolveHeadingPathWithLevel(ref.docPath, ref.headingPath);
  if (level === 0) return body;

  const heading = ref.headingPath[ref.headingPath.length - 1];
  return prependHeading(body, level, heading);
}
