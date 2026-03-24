import path from "node:path";
import crypto from "node:crypto";
import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  getProposalsDraftRoot,
  getProposalsPendingRoot,
  getProposalsCommittingRoot,
  getProposalsCommittedRoot,
  getProposalsWithdrawnRoot,
} from "./data-root.js";
import type {
  AnyProposal,
  AnyProposalFile,
  CommittedProposalFile,
  ProposalFileBase,
  ProposalId,
  ProposalSection,
  ProposalStatus,
  SectionScoreSnapshot,
  WithdrawnProposalFile,
  WriterIdentity,
} from "../types/shared.js";

export class ProposalNotFoundError extends Error {}
export class InvalidProposalStateError extends Error {}

const ALL_STATUSES: ProposalStatus[] = ["draft", "pending", "committing", "committed", "withdrawn"];

function statusDir(status: ProposalStatus): string {
  switch (status) {
    case "draft":
      return getProposalsDraftRoot();
    case "pending":
      return getProposalsPendingRoot();
    case "committing":
      return getProposalsCommittingRoot();
    case "committed":
      return getProposalsCommittedRoot();
    case "withdrawn":
      return getProposalsWithdrawnRoot();
  }
}

function proposalDir(status: ProposalStatus, id: ProposalId): string {
  return path.join(statusDir(status), id);
}

function proposalPath(status: ProposalStatus, id: ProposalId): string {
  return path.join(proposalDir(status, id), "meta.json");
}

export function generateProposalId(): ProposalId {
  return crypto.randomUUID();
}

/**
 * Content root for a proposal's section body files.
 * If status is provided, returns the path directly.
 * If omitted, locates the proposal first to determine its current status.
 */
export function proposalContentRoot(id: ProposalId, status: ProposalStatus): string {
  return path.join(statusDir(status), id, "content");
}

export async function locateProposalContentRoot(id: ProposalId): Promise<string> {
  const { status } = await locateProposal(id);
  return proposalContentRoot(id, status);
}

async function readJsonFile(filePath: string): Promise<AnyProposalFile> {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as AnyProposalFile;
}

async function writeJsonFile(filePath: string, data: AnyProposalFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function locateProposal(id: ProposalId): Promise<{ status: ProposalStatus; filePath: string }> {
  for (const status of ALL_STATUSES) {
    const filePath = proposalPath(status, id);
    try {
      await readFile(filePath, "utf8");
      return { status, filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new ProposalNotFoundError(`Proposal not found: ${id}`);
}

function toProposal(file: AnyProposalFile, status: ProposalStatus): AnyProposal {
  return { ...file, status } as AnyProposal;
}

export interface CreateProposalResult {
  id: ProposalId;
  contentRoot: string;
}

export async function createProposal(
  writer: WriterIdentity,
  intent: string,
  sections?: ProposalSection[],
): Promise<CreateProposalResult> {
  const id = generateProposalId();
  const now = new Date().toISOString();
  const file: ProposalFileBase = {
    id,
    writer,
    intent,
    sections: sections ?? [],
    created_at: now,
  };
  const contentRoot = proposalContentRoot(id, "draft");
  await mkdir(contentRoot, { recursive: true });
  await writeJsonFile(proposalPath("draft", id), file);
  if (writer.type === "agent") {
    const { agentEventLog } = await import("../mcp/agent-event-log.js");
    agentEventLog.append(writer, { kind: "proposal_created", proposalId: id });
  }
  return { id, contentRoot };
}

/**
 * Create a transient proposal in proposals/pending/ for atomic internal operations
 * (write_files, move_file, delete_document, PATCH, import, restore, crash recovery).
 *
 * These proposals are immediately committed after content is assembled. If found in
 * pending/ after a crash, they are debris and discarded on restart.
 */
export async function createTransientProposal(
  writer: WriterIdentity,
  intent: string,
  sections?: ProposalSection[],
): Promise<CreateProposalResult> {
  const id = generateProposalId();
  const now = new Date().toISOString();
  const file: ProposalFileBase = {
    id,
    writer,
    intent,
    sections: sections ?? [],
    created_at: now,
  };
  const contentRoot = proposalContentRoot(id, "pending");
  await mkdir(contentRoot, { recursive: true });
  await writeJsonFile(proposalPath("pending", id), file);
  return { id, contentRoot };
}

export async function readProposal(id: ProposalId): Promise<AnyProposal> {
  for (const status of ALL_STATUSES) {
    const filePath = proposalPath(status, id);
    try {
      const file = await readJsonFile(filePath);
      return toProposal(file, status);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  throw new ProposalNotFoundError(`Proposal not found: ${id}`);
}

/**
 * Read a proposal and its section content from the ContentLayer.
 * Returns the proposal metadata and a separate content map (keyed by "doc_path::heading>path").
 * Content lives on disk, never on the section objects.
 */
export async function readProposalWithContent(id: ProposalId): Promise<{ proposal: AnyProposal; sectionContent: Map<string, string> }> {
  const proposal = await readProposal(id);
  const contentRoot = proposalContentRoot(id, proposal.status);
  const layer = new ContentLayer(contentRoot);

  const batchResult = await layer.readSectionBatch(
    proposal.sections.map(s => SectionRef.fromTarget(s)),
  );

  return { proposal, sectionContent: batchResult };
}

export async function listProposals(status?: ProposalStatus): Promise<AnyProposal[]> {
  // Spec: "committing" proposals should be treated as pending for listing purposes
  const statuses = status
    ? (status === "draft" ? ["draft", "committing"] as ProposalStatus[] : [status])
    : ALL_STATUSES;
  const proposals: AnyProposal[] = [];

  for (const currentStatus of statuses) {
    let entries;
    try {
      entries = await readdir(statusDir(currentStatus), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const file = await readJsonFile(path.join(statusDir(currentStatus), entry.name, "meta.json"));
        proposals.push(toProposal(file, currentStatus));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }

  return proposals;
}

export async function findDraftProposalByWriter(writerId: string): Promise<AnyProposal | null> {
  const pending = await listProposals("draft");
  return pending.find((p) => p.writer.id === writerId) ?? null;
}

export interface UpdateProposalResult {
  proposal: AnyProposal;
  contentRoot: string;
}

export async function updateProposalSections(
  id: ProposalId,
  sections: ProposalSection[],
  intent?: string,
): Promise<UpdateProposalResult> {
  const { status, filePath } = await locateProposal(id);
  if (status !== "draft" && status !== "pending") {
    throw new InvalidProposalStateError(
      `Cannot update proposal ${id}: status is ${status}, expected draft or pending.`,
    );
  }
  const file = await readJsonFile(filePath);
  file.sections = sections;
  if (intent !== undefined) {
    file.intent = intent;
  }
  await writeJsonFile(filePath, file);
  const contentRoot = proposalContentRoot(id, status);
  return { proposal: toProposal(file, status), contentRoot };
}

export async function transitionToCommitting(id: ProposalId): Promise<AnyProposal> {
  const proposal = await readProposal(id);
  if (proposal.status !== "draft" && proposal.status !== "pending") {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to committing: status is ${proposal.status}, expected draft or pending.`,
    );
  }

  const fromDir = proposalDir(proposal.status, id);
  const toDir = proposalDir("committing", id);
  await mkdir(statusDir("committing"), { recursive: true });
  await rename(fromDir, toDir);

  return { ...proposal, status: "committing" };
}

export async function transitionToCommitted(
  id: ProposalId,
  committedHead: string,
  scoresAtCommit: SectionScoreSnapshot,
): Promise<AnyProposal> {
  const proposal = await readProposal(id);
  if (proposal.status !== "committing") {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to committed: status is ${proposal.status}, expected committing.`,
    );
  }

  // Write enriched meta.json BEFORE rename so the rename is the single atomic commit point.
  // If crash happens before rename: proposal stays in "committing" with enriched meta (harmless).
  // If crash happens after rename: proposal is in "committed" with correct meta.
  const { status: _s, ...rest } = proposal;
  const file: CommittedProposalFile = { ...rest, committed_head: committedHead, humanInvolvement_at_commit: scoresAtCommit };
  await writeJsonFile(proposalPath("committing", id), file);

  // Atomic directory rename
  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("committed", id);
  await mkdir(statusDir("committed"), { recursive: true });
  await rename(fromDir, toDir);

  return toProposal(file, "committed");
}

export async function transitionToWithdrawn(
  id: ProposalId,
  reason?: string,
): Promise<AnyProposal> {
  const proposal = await readProposal(id);
  if (proposal.status !== "draft" && proposal.status !== "pending") {
    throw new InvalidProposalStateError(
      `Cannot withdraw proposal ${id}: status is ${proposal.status}, expected draft or pending.`,
    );
  }

  // Write enriched meta.json BEFORE rename so the rename is the single atomic commit point.
  const { status: _s, ...rest } = proposal;
  const file: WithdrawnProposalFile = { ...rest, withdrawal_reason: reason };
  await writeJsonFile(proposalPath(proposal.status, id), file);

  // Atomic directory rename
  const fromDir = proposalDir(proposal.status, id);
  const toDir = proposalDir("withdrawn", id);
  await mkdir(statusDir("withdrawn"), { recursive: true });
  await rename(fromDir, toDir);

  if (proposal.writer.type === "agent") {
    const { agentEventLog } = await import("../mcp/agent-event-log.js");
    agentEventLog.append(proposal.writer, { kind: "proposal_withdrawn", proposalId: id });
  }
  return toProposal(file, "withdrawn");
}

export async function rollbackCommittingToDraft(id: ProposalId): Promise<AnyProposal> {
  const proposal = await readProposal(id);
  if (proposal.status !== "committing") {
    throw new InvalidProposalStateError(
      `Cannot rollback proposal ${id}: status is ${proposal.status}, expected committing.`,
    );
  }

  // Pure directory rename — no metadata change needed
  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("draft", id);
  await mkdir(statusDir("draft"), { recursive: true });
  await rename(fromDir, toDir);

  return { ...proposal, status: "draft" };
}
