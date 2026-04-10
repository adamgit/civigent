import { lookupDocSession } from "../../../crdt/ydoc-lifecycle.js";
import type { DocumentDiagnosticsContext } from "../context.js";

export async function runLiveCrdtSessionCheck(ctx: DocumentDiagnosticsContext): Promise<boolean> {
  try {
    const session = lookupDocSession(ctx.docPath);
    const hasLiveCrdtSession = !!session;
    ctx.pushCheck(
      "Session / Restore Checks",
      "live-crdt-session",
      hasLiveCrdtSession,
      session ? "active session" : undefined,
    );
    return hasLiveCrdtSession;
  } catch (err) {
    ctx.pushCheck("Session / Restore Checks", "live-crdt-session", false, err instanceof Error ? err.message : String(err));
    return false;
  }
}
