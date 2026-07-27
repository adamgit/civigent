import type {
  DocPath,
  DocumentActivityAgentEntry,
  DocumentActivityEvent,
  DocumentActivityHumanEntry,
  WriterIdentity,
} from "../types/shared.js";
import {
  getAttachedHumanDocumentEditors,
  getOpenHumanDocumentViewers,
} from "./crdt-ws-coordinator.js";
import { readRecentHumanDocumentActivity } from "./human-document-activity.js";
import { readAgentDraftOwnersForDocument } from "../storage/proposal-repository.js";
import { readRecentAgentCommitsForDocument } from "../storage/section-commit-history.js";

const AGENT_DOCUMENT_READ_RETENTION_MS = 60_000;

interface AgentDocumentReadEntry {
  writer: WriterIdentity;
  lastReadAtMs: number;
}

const agentReadsByDocPath = new Map<string, Map<string, AgentDocumentReadEntry>>();

function pruneExpiredAgentReads(docPathKey: string, nowMs: number): Map<string, AgentDocumentReadEntry> | undefined {
  const reads = agentReadsByDocPath.get(docPathKey);
  if (!reads) return undefined;
  for (const [writerId, entry] of reads) {
    if (nowMs - entry.lastReadAtMs > AGENT_DOCUMENT_READ_RETENTION_MS) reads.delete(writerId);
  }
  if (reads.size === 0) {
    agentReadsByDocPath.delete(docPathKey);
    return undefined;
  }
  return reads;
}

export function recordAgentDocumentRead(docPath: DocPath, writer: WriterIdentity): void {
  if (writer.type !== "agent") {
    throw new Error(
      `document-activity agent reads only record agent writers, got type "${writer.type}" for writer "${writer.id}"`,
    );
  }
  const nowMs = Date.now();
  let reads = pruneExpiredAgentReads(docPath, nowMs);
  if (!reads) {
    reads = new Map<string, AgentDocumentReadEntry>();
    agentReadsByDocPath.set(docPath, reads);
  }
  reads.set(writer.id, { writer, lastReadAtMs: nowMs });
}

function readRecentAgentDocumentReads(docPath: DocPath): Array<{ writer: WriterIdentity; lastReadSecondsAgo: number }> {
  const nowMs = Date.now();
  const reads = pruneExpiredAgentReads(docPath, nowMs);
  if (!reads) return [];
  return [...reads.values()].map((entry) => ({
    writer: entry.writer,
    lastReadSecondsAgo: Math.max(0, Math.floor((nowMs - entry.lastReadAtMs) / 1000)),
  }));
}

export async function buildDocumentActivityEvent(docPath: DocPath): Promise<DocumentActivityEvent> {
  const humansByWriterId = new Map<string, DocumentActivityHumanEntry>();
  for (const writer of getOpenHumanDocumentViewers(docPath)) {
    humansByWriterId.set(writer.id, { writer, page_open: true, editor_attached: false });
  }
  for (const writer of getAttachedHumanDocumentEditors(docPath)) {
    const row = humansByWriterId.get(writer.id);
    if (row) {
      row.editor_attached = true;
    } else {
      humansByWriterId.set(writer.id, { writer, page_open: true, editor_attached: true });
    }
  }
  for (const activity of readRecentHumanDocumentActivity(docPath)) {
    let row = humansByWriterId.get(activity.writer.id);
    if (!row) {
      row = { writer: activity.writer, page_open: false, editor_attached: false };
      humansByWriterId.set(activity.writer.id, row);
    }
    if (activity.lastWriteSecondsAgo !== undefined) {
      row.last_write_seconds_ago = activity.lastWriteSecondsAgo;
    }
    if (activity.lastEditorDetachSecondsAgo !== undefined) {
      row.last_editor_detach_seconds_ago = activity.lastEditorDetachSecondsAgo;
    }
  }

  const [draftOwners, recentCommits] = await Promise.all([
    readAgentDraftOwnersForDocument(docPath),
    readRecentAgentCommitsForDocument(docPath),
  ]);
  const agentsByWriterId = new Map<string, DocumentActivityAgentEntry>();
  for (const writer of draftOwners) {
    agentsByWriterId.set(writer.id, { writer, has_draft: true });
  }
  for (const read of readRecentAgentDocumentReads(docPath)) {
    let row = agentsByWriterId.get(read.writer.id);
    if (!row) {
      row = { writer: read.writer, has_draft: false };
      agentsByWriterId.set(read.writer.id, row);
    }
    row.last_read_seconds_ago = read.lastReadSecondsAgo;
  }
  for (const commit of recentCommits) {
    let row = agentsByWriterId.get(commit.writer.id);
    if (!row) {
      row = { writer: commit.writer, has_draft: false };
      agentsByWriterId.set(commit.writer.id, row);
    }
    row.last_commit_seconds_ago = commit.lastCommitSecondsAgo;
  }

  return {
    type: "document:activity",
    doc_path: docPath,
    humans: [...humansByWriterId.values()],
    agents: [...agentsByWriterId.values()],
  };
}

const documentActivitySendChains = new Map<string, Promise<void>>();

export function enqueueDocumentActivitySend(docPath: DocPath, send: () => Promise<void>): Promise<void> {
  const prior = documentActivitySendChains.get(docPath) ?? Promise.resolve();
  const run = prior.then(send);
  documentActivitySendChains.set(
    docPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

let documentActivityBroadcaster: ((event: DocumentActivityEvent) => void) | null = null;

export function setDocumentActivityBroadcaster(broadcaster: (event: DocumentActivityEvent) => void): void {
  documentActivityBroadcaster = broadcaster;
}

export function broadcastDocumentActivitySnapshot(docPath: DocPath): Promise<void> {
  return enqueueDocumentActivitySend(docPath, async () => {
    if (!documentActivityBroadcaster) return;
    documentActivityBroadcaster(await buildDocumentActivityEvent(docPath));
  });
}

export function sendDocumentActivitySnapshot(
  docPath: DocPath,
  send: (event: DocumentActivityEvent) => void,
): Promise<void> {
  return enqueueDocumentActivitySend(docPath, async () => {
    send(await buildDocumentActivityEvent(docPath));
  });
}
