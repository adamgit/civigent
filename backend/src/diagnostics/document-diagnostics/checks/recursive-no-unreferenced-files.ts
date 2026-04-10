import path from "node:path";
import {
  ensureRecursiveSkeleton,
  listRecursiveMdFiles,
  type DocumentDiagnosticsContext,
} from "../context.js";

export async function runRecursiveNoUnreferencedFilesCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const recursiveExpectedFiles = new Set(
      recursiveSkeleton.allStructuralEntries()
        .map((entry) => path.relative(ctx.canonicalSectionsDir, entry.absolutePath).replace(/\\/g, "/"))
        .filter((rel) => rel.length > 0 && !rel.startsWith("../")),
    );
    const recursiveDiskFiles = await listRecursiveMdFiles(ctx.canonicalSectionsDir);
    const recursiveUnreferenced = recursiveDiskFiles.filter((rel) => !recursiveExpectedFiles.has(rel));
    ctx.pushCheck(
      "Recursive Structure Checks",
      "recursive-no-unreferenced-files",
      recursiveUnreferenced.length === 0,
      recursiveUnreferenced.length > 0 ? recursiveUnreferenced.join(", ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
