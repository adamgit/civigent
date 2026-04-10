import path from "node:path";
import { assessSectionContent } from "../../../storage/recovery-layers.js";
import { ensureTopLevelSkeletonAssessment, type DocumentDiagnosticsContext } from "../context.js";

export async function runTopLevelAllSectionsParseableCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const assessment = await ensureTopLevelSkeletonAssessment(ctx);
    const unparseable: string[] = [];
    for (const entry of assessment.entries) {
      const result = await assessSectionContent(path.join(ctx.canonicalSectionsDir, entry.sectionFile), "canonical");
      if (!result.parseable) unparseable.push(entry.sectionFile);
    }
    ctx.pushCheck(
      "Top-Level Checks",
      "all-sections-parseable",
      unparseable.length === 0,
      unparseable.length > 0 ? unparseable.join(", ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Top-Level Checks", "all-sections-parseable", false, err instanceof Error ? err.message : String(err));
  }
}
