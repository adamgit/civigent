import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureTopLevelSkeletonAssessment, type DocumentDiagnosticsContext } from "../context.js";

export async function runTopLevelAllSectionsReadableCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const assessment = await ensureTopLevelSkeletonAssessment(ctx);
    const missing: string[] = [];
    for (const entry of assessment.entries) {
      try {
        await readFile(path.join(ctx.canonicalSectionsDir, entry.sectionFile), "utf8");
      } catch {
        missing.push(entry.sectionFile);
      }
    }
    ctx.pushCheck(
      "Top-Level Checks",
      "all-sections-readable",
      missing.length === 0,
      missing.length > 0 ? missing.join(", ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Top-Level Checks", "all-sections-readable", false, err instanceof Error ? err.message : String(err));
  }
}
