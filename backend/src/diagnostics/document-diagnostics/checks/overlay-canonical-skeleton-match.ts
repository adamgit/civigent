import { readFile } from "node:fs/promises";
import { assessSkeleton } from "../../../storage/recovery-layers.js";
import { ensureTopLevelSkeletonAssessment, type DocumentDiagnosticsContext } from "../context.js";

export async function runOverlayCanonicalSkeletonMatchCheck(
  ctx: DocumentDiagnosticsContext,
  overlaySkeletonExists: boolean,
): Promise<void> {
  try {
    if (!overlaySkeletonExists) return;
    const [overlayContent, canonicalContent] = await Promise.all([
      readFile(ctx.overlaySkeletonPath, "utf8").catch(() => null),
      readFile(ctx.canonicalSkeletonPath, "utf8").catch(() => null),
    ]);
    if (overlayContent === null || canonicalContent === null) return;
    const match = overlayContent === canonicalContent;
    const overlayAssessment = await assessSkeleton(ctx.overlaySkeletonPath, ctx.overlaySectionsDir);
    const canonicalAssessment = await ensureTopLevelSkeletonAssessment(ctx);
    ctx.pushCheck(
      "Session / Restore Checks",
      "overlay-canonical-skeleton-match",
      match,
      match ? undefined : `overlay: ${overlayAssessment.entries.length} entries, canonical: ${canonicalAssessment.entries.length} entries`,
    );
  } catch (err) {
    ctx.pushCheck("Session / Restore Checks", "overlay-canonical-skeleton-match", false, err instanceof Error ? err.message : String(err));
  }
}
