import { readFile } from "node:fs/promises";
import type { DocumentDiagnosticsContext } from "../context.js";

export async function runOverlaySkeletonExistsCheck(ctx: DocumentDiagnosticsContext): Promise<boolean> {
  try {
    let overlaySkeletonExists = false;
    try {
      await readFile(ctx.overlaySkeletonPath, "utf8");
      overlaySkeletonExists = true;
    } catch {
      // missing is expected for many docs
    }
    ctx.pushCheck("Session / Restore Checks", "overlay-skeleton-exists", overlaySkeletonExists);
    return overlaySkeletonExists;
  } catch (err) {
    ctx.pushCheck("Session / Restore Checks", "overlay-skeleton-exists", false, err instanceof Error ? err.message : String(err));
    return false;
  }
}
