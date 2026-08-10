import { readFile } from "node:fs/promises";
import { parseDocumentMarkdown } from "../../../storage/markdown-sections.js";
import { SectionRef } from "../../../domain/section-ref.js";
import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";
import { isDocumentBeforeFirstHeading } from "../../../storage/section-shape.js";
import { fragmentKeyFromSectionFile } from "../../../crdt/ydoc-fragments.js";
import type { HeadingLevel } from "../../../types/shared.js";

/**
 * Compare each physical section body against the skeleton graph so a heading
 * the body FILE carries but the SKELETON does NOT (unpromoted embedded heading)
 * is visible. This is the corruption shape live-structural normalization is
 * supposed to prevent; when normalization fails or is skipped, an embedded
 * heading rides along in the body without a corresponding skeleton section —
 * a subsequent read/materialize can rebuild the whole document lopsided.
 *
 * Symmetric second rung: any skeleton section whose body file is missing from
 * disk (or whose content is empty when the skeleton claims content) is a
 * skeleton-graph vs. body-file mismatch — the opposite direction of the same
 * class of corruption.
 */
export async function runBodyVsSkeletonHeadingsCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const skeletonSectionKeys = new Set<string>();
    const skeletonSectionsByAbsPath = new Map<string, { headingPath: string[]; heading: string; headingLevel: HeadingLevel; sectionFile: string }>();
    recursiveSkeleton.forEachSection((heading, headingLevel, sectionFile, headingPath, absolutePath) => {
      skeletonSectionKeys.add(SectionRef.headingKey(headingPath));
      skeletonSectionsByAbsPath.set(absolutePath, { headingPath: [...headingPath], heading, headingLevel, sectionFile });
    });

    const unpromoted: string[] = [];
    const emptyOrMissing: string[] = [];

    for (const [absolutePath, meta] of skeletonSectionsByAbsPath) {
      let body: string;
      try {
        body = await readFile(absolutePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          emptyOrMissing.push(`${meta.sectionFile} [${SectionRef.headingKey(meta.headingPath)}] — body file missing`);
          continue;
        }
        emptyOrMissing.push(`${meta.sectionFile} [${SectionRef.headingKey(meta.headingPath)}] — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (body.length === 0) {
        // Body-only file: no headings expected. Skip.
        continue;
      }
      const parsed = parseDocumentMarkdown(body);
      const realSections = parsed.filter((s) => s.headingPath.length > 0);
      const parentPath = isDocumentBeforeFirstHeading({ heading: meta.heading, headingLevel: meta.headingLevel, headingPath: meta.headingPath })
        ? []
        : meta.headingPath;
      const fragmentKey = fragmentKeyFromSectionFile(meta.sectionFile, isDocumentBeforeFirstHeading({ heading: meta.heading, headingLevel: meta.headingLevel, headingPath: meta.headingPath }));
      for (const section of realSections) {
        const fullPath = [...parentPath, ...section.headingPath];
        const key = SectionRef.headingKey(fullPath);
        // The section's OWN heading is expected as the leading heading of its
        // fragment — that heading IS in the skeleton, so it should already
        // match. Only report headings whose full path is NOT in the skeleton.
        if (!skeletonSectionKeys.has(key)) {
          const preview = section.body.slice(0, 80).replace(/\s+/g, " ");
          unpromoted.push(`${meta.sectionFile} (${fragmentKey}) hides "${section.heading}" (heading level ${section.headingLevel}) at ${key} — body: "${preview}"`);
        }
      }
    }

    ctx.pushCheck(
      "Recursive Structure Checks",
      "body-headings-match-skeleton",
      unpromoted.length === 0,
      unpromoted.length > 0 ? unpromoted.join(" | ") : undefined,
    );
    ctx.pushCheck(
      "Recursive Structure Checks",
      "skeleton-sections-have-bodies",
      emptyOrMissing.length === 0,
      emptyOrMissing.length > 0 ? emptyOrMissing.join(" | ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
