import { access } from "node:fs/promises";
import { getContentRoot } from "./data-root.js";
import { resolveDocPathUnderContent } from "./path-utils.js";
import type { DocPath } from "../types/shared.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import { buildFragmentContent, fragmentFromBodyHolder, type SectionBody, type FragmentContent } from "./section-formatting.js";
import { isDocumentBeforeFirstHeading } from "./section-shape.js";
import { HeadingLevel } from "../types/shared.js";
import type { AuthorizedDocRead } from "../auth/authorized-read.js";

// Re-export error classes from ContentLayer (callers import from here)
export { DirectoryAtDocPathError, DocumentNotFoundError, DocumentAssemblyError } from "./content-layer.js";

export async function readAssembledDocument(read: AuthorizedDocRead): Promise<string> {
  const contentRoot = getContentRoot();
  const docPath = read.docPath;
  resolveDocPathUnderContent(contentRoot, docPath);
  const layer = new ContentLayer(contentRoot);
  return layer.readAssembledDocument(docPath);
}

/**
 * Existence probe for a canonical document's skeleton file. Not an ACL
 * surface: answers only "does a canonical file exist at this path", the
 * precondition check the write/move/delete flows run before staging work.
 */
export async function canonicalDocumentExists(docPath: DocPath): Promise<boolean> {
  try {
    const resolvedPath = resolveDocPathUnderContent(getContentRoot(), docPath);
    await access(resolvedPath);
    return true;
  } catch {
    return false;
  }
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
  sections: Array<{ heading: string; headingLevel: HeadingLevel; headingPath: string[] }>,
  bodyMap: Map<string, SectionBody>,
): Map<string, FragmentContent> {
  const result = new Map<string, FragmentContent>();
  for (const [key, body] of bodyMap) {
    result.set(key, fragmentFromBodyHolder(body));
  }
  for (const { heading, headingLevel, headingPath } of sections) {
    if (isDocumentBeforeFirstHeading({ heading, headingLevel, headingPath })) continue;
    const key = SectionRef.headingKey(headingPath);
    const body = bodyMap.get(key);
    if (body == null) continue;
    result.set(key, buildFragmentContent(body, headingLevel, heading));
  }
  return result;
}
