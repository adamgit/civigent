import type {
  GetDocumentSectionsResponse,
  WsServerEvent,
  WriterIdentity,
  SectionEditRejectedEvent,
  SectionEditRejectedReasonCode,
  ClientInstanceId,
  ProposalTargetRef,
} from "../../types/shared.js";
import { emitCatalogMutationEvents, type CatalogMutationSummary } from "../../mcp/catalog-events.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { SectionRef } from "../../domain/section-ref.js";
import { DocPath } from "../../types/shared.js";





type StructureSections = GetDocumentSectionsResponse["sections"];

export { emitCatalogMutationEvents };
export type { CatalogMutationSummary };







export function groupSectionsByDocPath(
  sections: Array<{ doc_path: DocPath; heading_path: string[] }>,
): Map<DocPath, string[][]> {
  const headingPathsByDoc = new Map<DocPath, string[][]>();
  for (const section of sections) {
    if (!headingPathsByDoc.has(section.doc_path)) {
      headingPathsByDoc.set(section.doc_path, []);
    }
    headingPathsByDoc.get(section.doc_path)!.push(section.heading_path);
  }
  return headingPathsByDoc;
}

export function groupProposalTargetsByDocument(
  targets: ProposalTargetRef[],
): Map<string, string[][]> {
  const headingPathsByDoc = new Map<string, string[][]>();
  for (const target of targets) {
    let headingPaths = headingPathsByDoc.get(target.doc_path);
    if (!headingPaths) {
      headingPaths = [];
      headingPathsByDoc.set(target.doc_path, headingPaths);
    }
    if (target.kind === "section") headingPaths.push(target.heading_path);
  }
  return headingPathsByDoc;
}

export function emitProposalDraftEventsByDoc(
  emit: ((event: WsServerEvent) => void) | undefined,
  proposalId: string,
  writer: Pick<WriterIdentity, "id" | "displayName">,
  intent: string,
  targets: ProposalTargetRef[],
): void {
  if (!emit || targets.length === 0) return;
  for (const [docPath, headingPaths] of groupProposalTargetsByDocument(targets)) {
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
  targets: ProposalTargetRef[],
): void {
  if (!emit || targets.length === 0) return;
  for (const [docPath, headingPaths] of groupProposalTargetsByDocument(targets)) {
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
  targets: ProposalTargetRef[],
): void {
  if (!emit || targets.length === 0) return;
  for (const [docPath, headingPaths] of groupProposalTargetsByDocument(targets)) {
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
  targets: ProposalTargetRef[],
): void {
  if (!emit || targets.length === 0) return;
  for (const [docPath, headingPaths] of groupProposalTargetsByDocument(targets)) {
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






export function emitContentCommittedForSections(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: DocPath,
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
  docPath: DocPath,
  sections: StructureSections,
): void {
  if (!emit) return;
  emit({ type: "doc:structure-changed", doc_path: docPath, sections });
}






















export async function emitCanonicalStructureChanged(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: DocPath,
): Promise<void> {
  if (!emit) return;
  const { readCanonicalSectionList } = await import("./sections.js");
  const { systemDocRead } = await import("../../auth/authorized-read.js");
  const { systemAuthority } = await import("../../auth/system-authority.js");
  const { response } = await readCanonicalSectionList(
    systemDocRead(systemAuthority("doc:structure-changed event assembly"), docPath),
  );
  emitDocStructureChanged(emit, docPath, response.sections);
}







export async function resolveSectionFragmentKey(
  docPath: DocPath,
  headingPath: string[],
  currentProposalId: import("../../types/shared.js").ProposalId | null = null,
): Promise<string | null> {
  const layout = await resolveLiveSectionLayout(docPath, currentProposalId);
  const targetKey = new SectionRef(docPath, headingPath).globalKey;
  for (const entry of layout) {
    if (new SectionRef(docPath, entry.headingPath).globalKey === targetKey) {
      return entry.fragmentKey;
    }
  }
  return null;
}



















export async function emitSectionBlockState(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: DocPath,
  headingPaths: string[][],
  kind: "section:blocked" | "section:unblocked" | "section:gone",
  currentProposalId: import("../../types/shared.js").ProposalId | null = null,
): Promise<void> {
  if (!emit || headingPaths.length === 0) return;

  const layout = await resolveLiveSectionLayout(docPath, currentProposalId);

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

/**
 * Private, origin-only emitter for `section:edit-rejected`. Constructs the
 * user-facing rejection payload from an acceptance-gate rejection group and
 * hands it to a per-tab private-send callback keyed by
 * `(doc_path, clientInstanceId)`.
 *
 * The transport (`sendPrivate`) is supplied by the caller — the JSON WebSocket
 * hub owns per-tab routing (see `backend/src/ws/hub.ts` extension) so this
 * helper stays transport-agnostic. It deliberately does NOT route by
 * `writer_id`: one writer can have multiple tabs on the same document, and a
 * per-writer send would leak the rejection into unrelated tabs. It also does
 * NOT feed the normal document-wide broadcast callback, and it does NOT
 * emit any `doc:structural-error`-shaped state (that event type is
 * intentionally absent from the union — `doc:structure-changed` remains
 * reserved for topology updates only).
 */
export interface SectionEditRejectedGroupInput {
  fragmentKeys: string[];
  affectedFragments: Array<{
    fragmentKey: string;
    headingPath?: string[];
    heading?: string;
  }>;
  reasonCode: SectionEditRejectedReasonCode;
  title: string;
  message: string;
  whatHappened: string;
  whyRejected: string;
  serverAction: string;
  guidance: string;
}

export function emitSectionEditRejected(
  sendPrivate: (
    target: { docPath: DocPath; clientInstanceId: ClientInstanceId },
    event: SectionEditRejectedEvent,
  ) => void,
  target: { docPath: DocPath; clientInstanceId: ClientInstanceId | null },
  group: SectionEditRejectedGroupInput,
): void {
  if (target.clientInstanceId === null) return;
  const event: SectionEditRejectedEvent = {
    type: "section:edit-rejected",
    doc_path: target.docPath,
    rejected_by: "server",
    affected_fragments: group.affectedFragments.map((f) => ({
      fragment_key: f.fragmentKey,
      heading_path: f.headingPath,
      heading: f.heading,
    })),
    reason_code: group.reasonCode,
    title: group.title,
    message: group.message,
    what_happened: group.whatHappened,
    why_rejected: group.whyRejected,
    server_action: group.serverAction,
    guidance: group.guidance,
  };
  sendPrivate({ docPath: target.docPath, clientInstanceId: target.clientInstanceId }, event);
}
