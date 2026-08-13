import { resolveLiveSectionLayout } from "../../../crdt/live-section-layout.js";
import { readActiveProposal } from "../../../storage/proposal-repository.js";
import { SectionRef } from "../../../domain/section-ref.js";
import { resolveDiagnosticsDraftProposalId, type DocumentDiagnosticsContext } from "../context.js";

export async function runLiveClaimSetOrphansCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  const proposalId = await resolveDiagnosticsDraftProposalId(ctx.docPath);
  if (!proposalId) return;
  try {
    const layout = await resolveLiveSectionLayout(ctx.docPath, proposalId);
    const liveHeadingKeys = new Set(layout.map((entry) => SectionRef.headingKey(entry.headingPath)));
    const proposal = await readActiveProposal(proposalId);
    const orphans: string[] = [];
    for (const target of proposal.targets) {
      if (target.kind !== "section") continue;
      if (target.doc_path !== ctx.docPath) continue;
      if (liveHeadingKeys.has(SectionRef.headingKey(target.heading_path))) continue;
      orphans.push(target.heading_path.length > 0 ? target.heading_path.join(" > ") : "(before first heading)");
    }
    ctx.pushCheck(
      "Live",
      "live-claim-set-orphans",
      orphans.length === 0,
      orphans.length > 0 ? `claimed but absent from draft layout: ${orphans.join(" | ")}` : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Live", "live-claim-set-orphans", false, err instanceof Error ? err.message : String(err));
  }
}
