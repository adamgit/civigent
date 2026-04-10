import {
  collectDuplicateSectionFileDetails,
  ensureRecursiveSkeleton,
  type DocumentDiagnosticsContext,
} from "../context.js";

export async function runDuplicateSectionFilesInRecursiveSkeletonCheck(
  ctx: DocumentDiagnosticsContext,
): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const duplicateSectionFiles = collectDuplicateSectionFileDetails(recursiveSkeleton);
    ctx.pushCheck(
      "Recursive Structure Checks",
      "duplicate-section-files-in-recursive-skeleton",
      duplicateSectionFiles.length === 0,
      duplicateSectionFiles.length > 0 ? duplicateSectionFiles.join(" | ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
