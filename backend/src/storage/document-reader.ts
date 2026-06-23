import { getContentRoot } from "./data-root.js";
import { resolveDocPathUnderContent } from "./path-utils.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import { buildFragmentContent, fragmentFromBodyHolder, type SectionBody, type FragmentContent } from "./section-formatting.js";
import { isDocumentBeforeFirstHeading } from "./section-shape.js";

// Re-export error classes from ContentLayer (callers import from here)
export { DocumentNotFoundError, DocumentAssemblyError } from "./content-layer.js";

export async function readAssembledDocument(rawDocPath: string): Promise<string> {
  const contentRoot = getContentRoot();
  // Validate the doc path (throws InvalidDocPathError if bad)
  resolveDocPathUnderContent(contentRoot, rawDocPath);
  const layer = new ContentLayer(contentRoot);
  return layer.readAssembledDocument(rawDocPath);
}

/**
 * Build full fragment content (heading+body) for all headed sections.
 *
 * Takes a section list and a Map<headingKey, SectionBody> of body-only content,
 * returns a new Map<headingKey, FragmentContent> with heading prepended to each
 * non-root entry. Root entries (level=0, heading="") pass through as FragmentContent
 * (body-only IS fragment content for BFH sections).
 */
export function prependHeadings(
  sections: Array<{ heading: string; level: number; headingPath: string[] }>,
  bodyMap: Map<string, SectionBody>,
): Map<string, FragmentContent> {
  const result = new Map<string, FragmentContent>();
  for (const [key, body] of bodyMap) {
    result.set(key, fragmentFromBodyHolder(body));
  }
  for (const { heading, level, headingPath } of sections) {
    if (isDocumentBeforeFirstHeading({ heading, level, headingPath })) continue;
    const key = SectionRef.headingKey(headingPath);
    const body = bodyMap.get(key);
    if (body == null) continue;
    result.set(key, buildFragmentContent(body, level, heading));
  }
  return result;
}
