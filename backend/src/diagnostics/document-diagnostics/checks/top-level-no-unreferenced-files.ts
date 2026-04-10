import { ensureTopLevelSkeletonAssessment, type DocumentDiagnosticsContext } from "../context.js";

export async function runTopLevelNoUnreferencedFilesCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const assessment = await ensureTopLevelSkeletonAssessment(ctx);
    const unreferenced = assessment.unreferencedFiles;
    ctx.pushCheck(
      "Top-Level Checks",
      "no-unreferenced-files",
      unreferenced.length === 0,
      unreferenced.length > 0 ? unreferenced.join(", ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Top-Level Checks", "no-unreferenced-files", false, err instanceof Error ? err.message : String(err));
  }
}
