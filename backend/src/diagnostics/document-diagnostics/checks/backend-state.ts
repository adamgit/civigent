import { listInProgressProposalsForDoc } from "../../../storage/proposal-repository.js";
import type { DocumentDiagnosticsContext } from "../context.js";

/**
 * Populate `ctx.backendStates` with any backend-reported invalid/error state
 * we can observe today. Kept conservative — the initial signal is the presence
 * of a degraded `inprogress` proposal for this document (a durable proposal-
 * level corruption marker that the repository already tracks). The response
 * shape (`DiagBackendState[]`) is prepared so richer signals can hook in
 * without a further schema change.
 *
 * Distinct rungs:
 *   - `proposal`: a durable proposal-side defect (proposal file marked degraded,
 *     locks corrupted, etc.).
 *   - `live`:    a transient live-session error (session inspection failure,
 *     write policy violation, in-memory Y.Doc irrecoverable).
 *   - `canonical`: a durable canonical-side defect (skeleton unparseable, body
 *     files unreadable).
 *
 * Not a health check — it never pushes into `ctx.checks`. The diagnostics
 * banner treats a non-empty backend state as its own trigger.
 */
export async function runBackendStateCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  try {
    const inprogress = await listInProgressProposalsForDoc(ctx.docPath);
    for (const proposal of inprogress) {
      if (proposal.degraded && proposal.degraded.length > 0) {
        ctx.backendStates.push({
          kind: "proposal",
          message: `Inprogress proposal ${proposal.id} is degraded and cannot commit.`,
          details: [...proposal.degraded],
        });
      }
    }
  } catch (err) {
    ctx.backendStates.push({
      kind: "proposal",
      message: "Failed to enumerate inprogress proposals for this document.",
      details: [err instanceof Error ? err.message : String(err)],
    });
  }
}
