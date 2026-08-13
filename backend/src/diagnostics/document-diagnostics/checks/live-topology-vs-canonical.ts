import { resolveLiveSectionLayout } from "../../../crdt/live-section-layout.js";
import { fragmentKeyFromSectionFile } from "../../../crdt/ydoc-fragments.js";
import { isDocumentBeforeFirstHeading } from "../../../storage/section-shape.js";
import {
  ensureRecursiveSkeleton,
  resolveDiagnosticsDraftProposalId,
  type DocumentDiagnosticsContext,
} from "../context.js";

export async function runLiveTopologyVsCanonicalCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  const proposalId = await resolveDiagnosticsDraftProposalId(ctx.docPath);
  if (!proposalId) return;
  try {
    const layout = await resolveLiveSectionLayout(ctx.docPath, proposalId);
    const liveKeys = new Set(layout.map((entry) => entry.fragmentKey));
    const canonicalKeys = new Set<string>();
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    recursiveSkeleton.forEachSection((heading, headingLevel, sectionFile, headingPath) => {
      canonicalKeys.add(
        fragmentKeyFromSectionFile(sectionFile, isDocumentBeforeFirstHeading({ heading, headingLevel, headingPath })),
      );
    });
    const draftOnly = [...liveKeys].filter((key) => !canonicalKeys.has(key));
    const canonicalMissingFromDraft = [...canonicalKeys].filter((key) => !liveKeys.has(key));
    const parts: string[] = [];
    if (draftOnly.length > 0) parts.push(`draft-only: ${draftOnly.join(", ")}`);
    if (canonicalMissingFromDraft.length > 0) {
      parts.push(`canonical-missing-from-draft: ${canonicalMissingFromDraft.join(", ")}`);
    }
    ctx.pushCheck(
      "Live",
      "live-topology-vs-canonical",
      parts.length === 0,
      parts.length > 0 ? parts.join(" | ") : undefined,
    );
  } catch (err) {
    ctx.pushCheck("Live", "live-topology-vs-canonical", false, err instanceof Error ? err.message : String(err));
  }
}
