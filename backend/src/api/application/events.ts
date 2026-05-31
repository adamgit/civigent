import type { WsServerEvent, WriterIdentity } from "../../types/shared.js";
import { emitCatalogMutationEvents, type CatalogMutationSummary } from "../../mcp/catalog-events.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { SectionRef } from "../../domain/section-ref.js";

export { emitCatalogMutationEvents };
export type { CatalogMutationSummary };

// NOTE: the legacy proposal-injected-into-session event (and its emitter) is
// intentionally NOT defined here. That event was removed from the WS contract
// (shared-types) and the live-session injection model no longer exists. Do not
// reintroduce it. Only proposal lifecycle, catalog, and content:committed events
// the client needs are emitted from this module.

export function groupSectionsByDocPath(
  sections: Array<{ doc_path: string; heading_path: string[] }>,
): Map<string, string[][]> {
  const headingPathsByDoc = new Map<string, string[][]>();
  for (const section of sections) {
    if (!headingPathsByDoc.has(section.doc_path)) {
      headingPathsByDoc.set(section.doc_path, []);
    }
    headingPathsByDoc.get(section.doc_path)!.push(section.heading_path);
  }
  return headingPathsByDoc;
}

export function emitProposalDraftEventsByDoc(
  emit: ((event: WsServerEvent) => void) | undefined,
  proposalId: string,
  writer: Pick<WriterIdentity, "id" | "displayName">,
  intent: string,
  sections: Array<{ doc_path: string; heading_path: string[] }>,
): void {
  if (!emit || sections.length === 0) return;
  for (const [docPath, headingPaths] of groupSectionsByDocPath(sections)) {
    emit({
      type: "proposal:draft",
      proposal_id: proposalId,
      doc_path: docPath,
      heading_paths: headingPaths,
      writer_id: writer.id,
      writer_display_name: writer.displayName,
      intent,
    });
  }
}

export function emitProposalInProgressEventsByDoc(
  emit: ((event: WsServerEvent) => void) | undefined,
  proposalId: string,
  writer: Pick<WriterIdentity, "id" | "displayName">,
  intent: string,
  sections: Array<{ doc_path: string; heading_path: string[] }>,
): void {
  if (!emit || sections.length === 0) return;
  for (const [docPath, headingPaths] of groupSectionsByDocPath(sections)) {
    emit({
      type: "proposal:inprogress",
      proposal_id: proposalId,
      doc_path: docPath,
      heading_paths: headingPaths,
      writer_id: writer.id,
      writer_display_name: writer.displayName,
      intent,
    });
  }
}

export function emitProposalWithdrawnEventsByDoc(
  emit: ((event: WsServerEvent) => void) | undefined,
  proposalId: string,
  sections: Array<{ doc_path: string; heading_path: string[] }>,
): void {
  if (!emit || sections.length === 0) return;
  for (const [docPath, headingPaths] of groupSectionsByDocPath(sections)) {
    emit({
      type: "proposal:withdrawn",
      proposal_id: proposalId,
      doc_path: docPath,
      heading_paths: headingPaths,
    });
  }
}

export function emitContentCommittedEventsByDoc(
  emit: ((event: WsServerEvent) => void) | undefined,
  writer: Pick<WriterIdentity, "id" | "type" | "displayName">,
  contributorIds: string[],
  commitSha: string,
  sections: Array<{ doc_path: string; heading_path: string[] }>,
): void {
  if (!emit || sections.length === 0) return;
  for (const [docPath, headingPaths] of groupSectionsByDocPath(sections)) {
    emit({
      type: "content:committed",
      doc_path: docPath,
      sections: headingPaths.map((headingPath) => ({ doc_path: docPath, heading_path: headingPath })),
      commit_sha: commitSha,
      writer_id: writer.id,
      writer_display_name: writer.displayName,
      writer_type: writer.type,
      contributor_ids: contributorIds,
      seconds_ago: 0,
    });
  }
}

/**
 * Emit a single content:committed event for an already-grouped (single-doc)
 * section set, used by the import-commit and patch paths which carry an
 * explicit per-doc section list rather than re-grouping.
 */
export function emitContentCommittedForSections(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: string,
  sections: Array<{ doc_path: string; heading_path: string[] }>,
  commitSha: string,
  writer: Pick<WriterIdentity, "id" | "type" | "displayName">,
  contributorIds: string[],
): void {
  if (!emit) return;
  emit({
    type: "content:committed",
    doc_path: docPath,
    sections,
    commit_sha: commitSha,
    writer_id: writer.id,
    writer_display_name: writer.displayName,
    writer_type: writer.type,
    contributor_ids: contributorIds,
    seconds_ago: 0,
  });
}

export function emitDocStructureChanged(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: string,
): void {
  if (!emit) return;
  emit({ type: "doc:structure-changed", doc_path: docPath });
}

/**
 * MW-5: resolve the opaque CRDT `fragment_key` for a single section from the
 * canonical (or current live-proposal) layout. Returns null when the section
 * does not resolve. Used to capture a `section:gone` fragment_key BEFORE a
 * structural delete tears the section's identity down.
 */
export async function resolveSectionFragmentKey(
  docPath: string,
  headingPath: string[],
  currentProposalId: import("../../types/shared.js").ProposalId | null = null,
): Promise<string | null> {
  let layout: Awaited<ReturnType<typeof resolveLiveSectionLayout>>;
  try {
    layout = await resolveLiveSectionLayout(docPath, currentProposalId);
  } catch {
    return null;
  }
  const targetKey = new SectionRef(docPath, headingPath).globalKey;
  for (const entry of layout) {
    if (new SectionRef(docPath, entry.headingPath).globalKey === targetKey) {
      return entry.fragmentKey;
    }
  }
  return null;
}

/**
 * MW-5: emit per-section CRDT block-state events (`section:blocked` /
 * `section:unblocked` / `section:gone`) on the JSON application WebSocket.
 *
 * A section's `fragment_key` is the opaque backend-owned CRDT fragment identity.
 * We resolve it from the live section layout (the DocSession's current `inprogress`
 * proposal skeleton if one is live for the doc, else canonical) so blocked/unblocked
 * events carry the SAME `fragment_key` the live editor's Y.Doc uses, keeping the
 * browser's per-section mount Set in lockstep with server reality.
 *
 * The fragment key is derived from the document SKELETON (the section file id),
 * not from the heading path alone, so it can only be resolved while the section
 * still exists in the layout. Callers emitting `section:gone` must therefore call
 * this BEFORE the structural delete commits (while the section still resolves);
 * a heading that does not resolve falls back to its globally-unique SectionRef key
 * so the event is still emitted (the frontend only needs a stable identity to
 * un-mount), rather than being dropped silently.
 */
export async function emitSectionBlockState(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: string,
  headingPaths: string[][],
  kind: "section:blocked" | "section:unblocked" | "section:gone",
  currentProposalId: import("../../types/shared.js").ProposalId | null = null,
): Promise<void> {
  if (!emit || headingPaths.length === 0) return;

  let layout: Awaited<ReturnType<typeof resolveLiveSectionLayout>> = [];
  try {
    layout = await resolveLiveSectionLayout(docPath, currentProposalId);
  } catch {
    // Skeleton may already be gone (e.g. whole-document delete). Fall back to
    // canonical SectionRef-derived fragment keys below.
    layout = [];
  }

  const fragmentKeyByGlobalKey = new Map<string, { fragmentKey: string; headingPath: string[] }>();
  for (const entry of layout) {
    fragmentKeyByGlobalKey.set(
      new SectionRef(docPath, entry.headingPath).globalKey,
      { fragmentKey: entry.fragmentKey, headingPath: entry.headingPath },
    );
  }

  const emitted = new Set<string>();
  for (const headingPath of headingPaths) {
    const ref = new SectionRef(docPath, headingPath);
    const resolved = fragmentKeyByGlobalKey.get(ref.globalKey);
    const fragmentKey = resolved?.fragmentKey ?? ref.globalKey;
    if (emitted.has(fragmentKey)) continue;
    emitted.add(fragmentKey);
    emit({
      type: kind,
      doc_path: docPath,
      fragment_key: fragmentKey,
      heading_path: headingPath,
    });
  }
}
