import {
  collectDuplicateFragmentKeyDetails,
  ensureRecursiveSkeleton,
  type DocumentDiagnosticsContext,
} from "../context.js";

export async function runDuplicateFragmentKeysCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const duplicateFragmentKeys = collectDuplicateFragmentKeyDetails(recursiveSkeleton);
    ctx.pushCheck(
      "Recursive Structure Checks",
      "duplicate-fragment-keys",
      duplicateFragmentKeys.length === 0,
      duplicateFragmentKeys.length > 0 ? duplicateFragmentKeys.join(" | ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
