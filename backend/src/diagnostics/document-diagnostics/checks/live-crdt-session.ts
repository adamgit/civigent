import { lookupDocSession } from "../../../crdt/ydoc-lifecycle.js";
import type { DocumentDiagnosticsContext } from "../context.js";

export async function runLiveCrdtSessionCheck(ctx: DocumentDiagnosticsContext): Promise<boolean> {
  try {
    const session = lookupDocSession(ctx.docPath);
    if (!session) {
      ctx.pushCheck("Live", "live-crdt-session", true, "no-session");
      return false;
    }
    ctx.pushCheck("Live", "live-crdt-session", true, "active");
    return true;
  } catch (err) {
    // A session exists but cannot be inspected — a real failure.
    ctx.pushCheck(
      "Live",
      "live-crdt-session",
      false,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
