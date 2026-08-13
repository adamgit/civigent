import { lookupDocSession } from "../../../crdt/ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "../../../crdt/live-section-layout.js";
import { fragmentKeyFromSectionFile } from "../../../crdt/ydoc-fragments.js";
import { isDocumentBeforeFirstHeading } from "../../../storage/section-shape.js";
import { ensureRecursiveSkeleton, type DocumentDiagnosticsContext } from "../context.js";

export async function runLiveTopologyVsCanonicalCheck(ctx: DocumentDiagnosticsContext): Promise<void> {
  const session = lookupDocSession(ctx.docPath);
  if (!session) return;
  try {
    const layout = await resolveLiveSectionLayout(ctx.docPath, session.generator.getCurrentProposalId());
    const liveKeys = new Set(layout.map((entry) => entry.fragmentKey));
    const canonicalKeys = new Set<string>();
    const recursiveSkeleton = await ensureRecursiveSkeleton(ctx);
    recursiveSkeleton.forEachSection((heading, headingLevel, sectionFile, headingPath) => {
      canonicalKeys.add(
        fragmentKeyFromSectionFile(sectionFile, isDocumentBeforeFirstHeading({ heading, headingLevel, headingPath })),
      );
    });
    const crdtOnly = [...liveKeys].filter((key) => !canonicalKeys.has(key));
    const canonicalMissingFromLive = [...canonicalKeys].filter((key) => !liveKeys.has(key));
    const parts: string[] = [];
    if (crdtOnly.length > 0) parts.push(`crdt-only: ${crdtOnly.join(", ")}`);
    if (canonicalMissingFromLive.length > 0) parts.push(`canonical-missing-from-live: ${canonicalMissingFromLive.join(", ")}`);
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
