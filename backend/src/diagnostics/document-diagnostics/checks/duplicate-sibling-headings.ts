import {
  collectDuplicateSiblingHeadingDetails,
  ensureRecursiveSkeleton,
  type DocumentDiagnosticsContext,
} from "../context.js";

/**
 * Fail hard when the recursive skeleton contains a sibling-list with two
 * direct children carrying the same heading. Complements the identical-path
 * check by catching illegal shapes buried inside sub-skeletons that the flat
 * heading-key map masks. Reported as a red health-check failure — normal
 * document reads cannot uniquely address one of the physical rows.
 */
export async function runDuplicateSiblingHeadingsCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const duplicates = collectDuplicateSiblingHeadingDetails(recursiveSkeleton);
    ctx.pushCheck(
      "Canonical",
      "duplicate-sibling-headings",
      duplicates.length === 0,
      duplicates.length > 0 ? duplicates.join(" | ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
