import { lookupDocSession } from "../../../crdt/ydoc-lifecycle.js";
import type { DocumentDiagnosticsContext } from "../context.js";

/**
 * Session-presence check. NOT a health signal: after a refresh (or between
 * sessions) the in-memory Y.Doc is gone by design — the durable state lives on
 * disk (canonical + `inprogress` proposal). Reporting "no session" as red
 * implied corruption; reporting it as green implied health it does not prove.
 * The check now passes with a NEUTRAL detail message when no session exists,
 * so the section-layers panel is understood to be disk-only. Only a real
 * inspection error against an existing session is a genuine failure.
 */
export async function runLiveCrdtSessionCheck(ctx: DocumentDiagnosticsContext): Promise<boolean> {
  try {
    const session = lookupDocSession(ctx.docPath);
    if (!session) {
      ctx.pushCheck(
        "Session / Restore Checks",
        "live-crdt-session",
        true,
        "No live session; diagnostics are disk-only.",
      );
      return false;
    }
    ctx.pushCheck(
      "Session / Restore Checks",
      "live-crdt-session",
      true,
      "active session",
    );
    return true;
  } catch (err) {
    // A session exists but cannot be inspected — a real failure.
    ctx.pushCheck(
      "Session / Restore Checks",
      "live-crdt-session",
      false,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
