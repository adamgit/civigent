import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";

export async function runRecursiveStructureLoadCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const structuralEntries = recursiveSkeleton.allStructuralEntries();
    const contentEntries = recursiveSkeleton.allContentEntries();
    ctx.summary.recursive_structural_entries = structuralEntries.length;
    ctx.summary.recursive_content_sections = contentEntries.length;
    ctx.summary.recursive_subskeleton_parents = structuralEntries.filter((entry) => entry.isSubSkeleton).length;
    ctx.summary.recursive_max_depth = contentEntries.reduce((max, entry) => Math.max(max, entry.headingPath.length), 0);
    ctx.pushCheck("Recursive Structure Checks", "recursive-structure-load", true, `${structuralEntries.length} structural entries`);
  } catch (err) {
    ctx.pushCheck("Recursive Structure Checks", "recursive-structure-load", false, err instanceof Error ? err.message : String(err));
  }
}
