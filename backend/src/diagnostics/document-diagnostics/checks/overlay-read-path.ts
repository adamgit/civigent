import { OverlayContentLayer } from "../../../storage/content-layer.js";
import type { DocumentDiagnosticsContext } from "../context.js";

export async function runOverlayReadPathCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const overlayLayer = new OverlayContentLayer(ctx.overlayContentRoot, ctx.contentRoot);
    await overlayLayer.readAllSections(ctx.docPath);
    ctx.pushCheck("Session / Restore Checks", "overlay-read-path", true);
  } catch (err) {
    ctx.pushCheck("Session / Restore Checks", "overlay-read-path", false, err instanceof Error ? err.message : String(err));
  }
}
