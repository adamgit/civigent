import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";

export async function runRecursiveNoStaleSubskeletonFilesCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const recursiveStale: string[] = [];
    for (const entry of recursiveSkeleton.allStructuralEntries().filter((item) => item.isSubSkeleton)) {
      try {
        const content = await readFile(entry.absolutePath, "utf8");
        if (!/\{\{section:\s*[^|}]+?\s*(?:\|[^}]*)?\}\}/.test(content)) {
          recursiveStale.push(path.relative(ctx.canonicalSectionsDir, entry.absolutePath).replace(/\\/g, "/"));
        }
      } catch {
        recursiveStale.push(path.relative(ctx.canonicalSectionsDir, entry.absolutePath).replace(/\\/g, "/"));
      }
    }
    ctx.pushCheck(
      "Recursive Structure Checks",
      "recursive-no-stale-subskeleton-files",
      recursiveStale.length === 0,
      recursiveStale.length > 0 ? recursiveStale.join(", ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
