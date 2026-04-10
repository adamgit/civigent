import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";

export async function runRecursiveAllSectionsReadableCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    const recursiveMissing: string[] = [];
    for (const entry of recursiveSkeleton.allContentEntries()) {
      try {
        await readFile(entry.absolutePath, "utf8");
      } catch {
        recursiveMissing.push(path.relative(ctx.canonicalSectionsDir, entry.absolutePath).replace(/\\/g, "/"));
      }
    }
    ctx.pushCheck(
      "Recursive Structure Checks",
      "recursive-all-sections-readable",
      recursiveMissing.length === 0,
      recursiveMissing.length > 0 ? recursiveMissing.join(", ") : undefined,
    );
  } catch {
    // Covered by recursive-structure-load
  }
}
