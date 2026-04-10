import type { DocumentDiagnosticsContext } from "../context.js";

export async function runOverlaySkeletonOrphanedCheck(
  ctx: DocumentDiagnosticsContext,
  overlaySkeletonExists: boolean,
  hasLiveCrdtSession: boolean,
): Promise<void> {
  ctx.pushCheck(
    "Session / Restore Checks",
    "overlay-skeleton-orphaned",
    !(overlaySkeletonExists && !hasLiveCrdtSession),
    overlaySkeletonExists && !hasLiveCrdtSession
      ? "Overlay skeleton exists but no active CRDT session — stale file will shadow canonical content"
      : undefined,
  );
}
