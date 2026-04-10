import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { ensureTopLevelSkeletonAssessment, type DocumentDiagnosticsContext } from "../context.js";

export async function runTopLevelNoStaleSectionsDirsCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const assessment = await ensureTopLevelSkeletonAssessment(ctx);
    const stale: string[] = [];
    for (const entry of assessment.entries) {
      const subDir = path.join(ctx.canonicalSectionsDir, `${entry.sectionFile}.sections`);
      let subDirExists = false;
      try {
        await readdir(subDir);
        subDirExists = true;
      } catch {
        // missing child dir is fine
      }
      if (!subDirExists) continue;
      try {
        const content = await readFile(path.join(ctx.canonicalSectionsDir, entry.sectionFile), "utf8");
        if (!/\{\{section:\s*[^|}]+?\s*(?:\|[^}]*)?\}\}/.test(content)) {
          stale.push(entry.sectionFile);
        }
      } catch {
        // unreadable body is covered by other checks
      }
    }
    ctx.pushCheck(
      "Top-Level Checks",
      "no-stale-sections-dirs",
      stale.length === 0,
      stale.length > 0 ? stale.join(", ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Top-Level Checks", "no-stale-sections-dirs", false, err instanceof Error ? err.message : String(err));
  }
}
