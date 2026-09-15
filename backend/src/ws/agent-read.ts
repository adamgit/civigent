import type {
  AgentRead,
  DocPath,
  HeadingPath,
  WriterIdentity,
  WsServerEvent,
} from "../types/shared.js";

type AgentReadActor = Pick<WriterIdentity, "id" | "displayName">;
type AgentReadEmitter = (event: WsServerEvent) => void;

function emitAgentRead(read: AgentRead, emit: AgentReadEmitter): void {
  emit({ type: "agent:reading", ...read });
}

export const recordAgentRead = {
  canonicalDocument(actor: AgentReadActor, docPath: DocPath, emit: AgentReadEmitter): void {
    emitAgentRead({
      kind: "document_read",
      source: "canonical",
      occurred_at_ms: Date.now(),
      actor_id: actor.id,
      actor_display_name: actor.displayName,
      doc_path: docPath,
    }, emit);
  },

  canonicalSectionNames(actor: AgentReadActor, docPath: DocPath, emit: AgentReadEmitter): void {
    emitAgentRead({
      kind: "section_names",
      source: "canonical",
      occurred_at_ms: Date.now(),
      actor_id: actor.id,
      actor_display_name: actor.displayName,
      doc_path: docPath,
    }, emit);
  },

  canonicalSection(
    actor: AgentReadActor,
    docPath: DocPath,
    headingPath: HeadingPath,
    emit: AgentReadEmitter,
  ): void {
    emitAgentRead({
      kind: "section_read",
      source: "canonical",
      occurred_at_ms: Date.now(),
      actor_id: actor.id,
      actor_display_name: actor.displayName,
      doc_path: docPath,
      heading_path: headingPath,
    }, emit);
  },

  historicalSection(
    actor: AgentReadActor,
    docPath: DocPath,
    headingPath: HeadingPath,
    emit: AgentReadEmitter,
  ): void {
    emitAgentRead({
      kind: "section_read",
      source: "history",
      occurred_at_ms: Date.now(),
      actor_id: actor.id,
      actor_display_name: actor.displayName,
      doc_path: docPath,
      heading_path: headingPath,
    }, emit);
  },
} as const;
