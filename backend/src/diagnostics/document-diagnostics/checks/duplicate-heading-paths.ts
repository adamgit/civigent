import {
  collectDuplicateHeadingPathDetails,
  ensureRecursiveSkeleton,
  type DocumentDiagnosticsContext,
} from "../context.js";

/**
 * Fail hard when the recursive canonical layout contains multiple sections at
 * the same `SectionRef.headingKey(...)`. This is a distinct rung from the
 * fragment-key and section-file duplicate checks: two sections can share a
 * heading path while carrying distinct section files (the physical duplication
 * case the app's heading-key-keyed reads would silently collapse). Reported as
 * a red health-check failure — not a warning — because normal document reads
 * cannot uniquely address one of the physical rows once this shape exists.
 */
export async function runDuplicateHeadingPathsCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const duplicates = collectDuplicateHeadingPathDetails(recursiveSkeleton);
    ctx.pushCheck(
      "Recursive Structure Checks",
      "duplicate-heading-paths",
      duplicates.length === 0,
      duplicates.length > 0 ? duplicates.join(" | ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
