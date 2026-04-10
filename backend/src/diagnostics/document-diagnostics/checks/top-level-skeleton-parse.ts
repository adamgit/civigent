import { ensureTopLevelSkeletonAssessment, type DocumentDiagnosticsContext } from "../context.js";

export async function runTopLevelSkeletonParseCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const assessment = await ensureTopLevelSkeletonAssessment(ctx);
    ctx.summary.top_level_entries = assessment.entries.length;
    ctx.pushCheck(
      "Top-Level Checks",
      "skeleton-parse",
      assessment.parsedCleanly,
      assessment.parsedCleanly ? `${assessment.entries.length} entries` : assessment.parseError?.message,
    );
  } catch (err) {
    ctx.pushCheck("Top-Level Checks", "skeleton-parse", false, err instanceof Error ? err.message : String(err));
  }
}
