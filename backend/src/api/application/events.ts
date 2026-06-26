import type { GetDocumentSectionsResponse, WsServerEvent, WriterIdentity } from "../../types/shared.js";
import { emitCatalogMutationEvents, type CatalogMutationSummary } from "../../mcp/catalog-events.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { SectionRef } from "../../domain/section-ref.js";





type StructureSections = GetDocumentSectionsResponse["sections"];

export { emitCatalogMutationEvents };
export type { CatalogMutationSummary };







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
  sections: StructureSections,
): void {
  if (!emit) return;
  emit({ type: "doc:structure-changed", doc_path: docPath, sections });
}














export async function emitLiveStructureChanged(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: string,
  currentProposalId: string | null,
  liveEditor?: Pick<WriterIdentity, "id" | "type" | "displayName">,
): Promise<void> {
  if (!emit) return;
  const { readProposalSectionList, readCanonicalSectionList } = await import("./sections.js");
  const { response } = currentProposalId
    ? await readProposalSectionList(currentProposalId, docPath)
    : await readCanonicalSectionList(docPath);
  const sections = liveEditor
    ? response.sections.map((s) => overrideUnknownLastEditorWithLiveWriter(s, liveEditor))
    : response.sections;
  emitDocStructureChanged(emit, docPath, sections);
}












function overrideUnknownLastEditorWithLiveWriter<T extends StructureSections[number]>(
  section: T,
  liveEditor: Pick<WriterIdentity, "id" | "type" | "displayName">,
): T {
  const editor = section.last_editor;
  const isUnknownSentinel =
    !!editor && editor.id === "unknown" && editor.name === "unknown" && editor.timestampMs === 0;
  if (!isUnknownSentinel) return section;
  return {
    ...section,
    last_editor: {
      id: liveEditor.id,
      name: liveEditor.displayName,
      type: liveEditor.type,
      timestampMs: Date.now(),
      seconds_ago: 0,
    },
  };
}







export async function emitCanonicalStructureChanged(
  emit: ((event: WsServerEvent) => void) | undefined,
  docPath: string,
): Promise<void> {
  if (!emit) return;
  const { readCanonicalSectionList } = await import("./sections.js");
  const { response } = await readCanonicalSectionList(docPath);
  emitDocStructureChanged(emit, docPath, response.sections);
}







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
