import { resolveLiveSectionLayout } from "../../../crdt/live-section-layout.js";
import { SectionRef } from "../../../domain/section-ref.js";
import { resolveDiagnosticsDraftProposalId, type DocumentDiagnosticsContext } from "../context.js";

export async function runLiveDuplicateHeadingPathsCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  const proposalId = await resolveDiagnosticsDraftProposalId(ctx.docPath);
  if (!proposalId) return;
  try {
    const layout = await resolveLiveSectionLayout(ctx.docPath, proposalId);
    const groups = new Map<string, Array<{ fragmentKey: string; headingPath: string[] }>>();
    for (const entry of layout) {
      const key = SectionRef.headingKey(entry.headingPath);
      const row = { fragmentKey: entry.fragmentKey, headingPath: [...entry.headingPath] };
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    const duplicates: string[] = [];
    for (const [, rows] of groups) {
      if (rows.length < 2) continue;
      const label = rows[0].headingPath.length > 0 ? rows[0].headingPath.join(" > ") : "(before first heading)";
      duplicates.push(`${label}: ${rows.map((r) => r.fragmentKey).join(", ")}`);
    }
    ctx.pushCheck(
      "Live",
      "live-duplicate-heading-paths",
      duplicates.length === 0,
      duplicates.length > 0 ? duplicates.join(" | ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Live", "live-duplicate-heading-paths", false, err instanceof Error ? err.message : String(err));
  }
}
