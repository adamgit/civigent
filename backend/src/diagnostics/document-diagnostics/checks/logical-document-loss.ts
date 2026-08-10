import { SectionRef } from "../../../domain/section-ref.js";
import { ContentLayer } from "../../../storage/content-layer.js";
import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";
import { fragmentKeyFromSectionFile } from "../../../crdt/ydoc-fragments.js";
import { isBodyHolderShape } from "../../../storage/section-shape.js";

/**
 * Fail when the document is LOGICALLY lossy: physical section files exist on
 * disk (recursive skeleton) that no longer resolve through normal heading-path
 * APIs. Two distinct rungs:
 *
 *   - physical > unique heading paths: recursive layout carries two body files
 *     at the same heading path, so a heading-key-keyed map (or any read that
 *     indexes by heading path) collapses one of them out of sight.
 *   - physical > API-returned sections: the public `listHeadingPaths` /
 *     `readSkeleton.forEachSection` view drops rows a physical walk sees. That
 *     is the same collapse observed through the API surface — reported
 *     separately so an operator can tell how the app-level read behaves.
 *
 * Report the hidden/lost section files with their heading paths so the operator
 * knows which physical bodies the app cannot reach.
 */
export async function runLogicalDocumentLossCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const physical: Array<{ headingKey: string; sectionFile: string; fragmentKey: string; headingPath: string[] }> = [];
    recursiveSkeleton.forEachSection((heading, headingLevel, sectionFile, headingPath) => {
      physical.push({
        headingKey: SectionRef.headingKey(headingPath),
        sectionFile,
        fragmentKey: fragmentKeyFromSectionFile(sectionFile, isBodyHolderShape({ heading, headingLevel }) && headingPath.length === 0),
        headingPath: [...headingPath],
      });
    });

    const uniqueHeadingKeys = new Set(physical.map((p) => p.headingKey));
    const physicalCount = physical.length;
    const uniqueCount = uniqueHeadingKeys.size;
    ctx.summary.physical_section_count = physicalCount;
    ctx.summary.logical_section_count = uniqueCount;

    // Rung 1 — physical > unique heading paths (map-level collapse).
    if (physicalCount > uniqueCount) {
      const seen = new Set<string>();
      const hidden = physical.filter((p) => {
        if (seen.has(p.headingKey)) return true;
        seen.add(p.headingKey);
        return false;
      });
      const detail = `${physicalCount} physical vs ${uniqueCount} unique heading paths — hidden: ${hidden
        .map((h) => `${h.sectionFile} [${h.headingKey}]`)
        .join(", ")}`;
      ctx.pushCheck("Recursive Structure Checks", "no-logical-loss-in-heading-map", false, detail);
    } else {
      ctx.pushCheck("Recursive Structure Checks", "no-logical-loss-in-heading-map", true);
    }

    // Rung 2 — physical > API-returned (public-API-level collapse).
    try {
      const layer = new ContentLayer(ctx.contentRoot);
      const apiHeadingPaths = await layer.listHeadingPaths(ctx.docPath);
      const apiCount = apiHeadingPaths.length;
      ctx.summary.api_section_count = apiCount;
      if (physicalCount !== apiCount) {
        const apiSet = new Set(apiHeadingPaths.map((p) => SectionRef.headingKey(p)));
        const lost = physical.filter((p) => !apiSet.has(p.headingKey));
        const detail = `${physicalCount} physical vs ${apiCount} API-returned — API-hidden: ${lost
          .map((h) => `${h.sectionFile} [${h.headingKey}]`)
          .join(", ") || "(count-only mismatch)"}`;
        ctx.pushCheck("Recursive Structure Checks", "public-api-returns-every-physical-section", false, detail);
      } else {
        ctx.pushCheck("Recursive Structure Checks", "public-api-returns-every-physical-section", true);
      }
    } catch (err) {
      ctx.pushCheck(
        "Recursive Structure Checks",
        "public-api-returns-every-physical-section",
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch {
    // Covered by recursive-structure-load
  }
}
