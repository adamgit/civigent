import path from "node:path";
import crypto from "node:crypto";
import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  getProposalsDraftRoot,
  getProposalsPendingRoot,
  getProposalsInProgressRoot,
  getProposalsCommittingRoot,
  getProposalsCommittedRoot,
  getProposalsWithdrawnRoot,
} from "./data-root.js";
import type {
  AnyProposal,
  AnyProposalFile,
  CommittedProposalFile,
  InProgressProposal,
  InProgressProposalFile,
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

/**
 * Returns true if the proposal is in a state where its sections can be modified.
 * Draft proposals are always mutable. Human proposals in inprogress are also mutable
 * (they hold section locks and can continue editing before final commit).
 */
export function isProposalMutable(proposal: AnyProposal): boolean {
  if (proposal.status === "draft") return true;
  if (proposal.status === "inprogress" && proposal.writer.type === "human") return true;
  return false;
}

export const PROPOSAL_STATUSES = [
  "draft",
  "pending",
  "inprogress",
  "committing",
  "committed",
  "withdrawn",
] as const satisfies readonly ProposalStatus[];

const ALL_STATUSES: ProposalStatus[] = [...PROPOSAL_STATUSES];

export function isProposalStatus(value: unknown): value is ProposalStatus {
  if (typeof value !== "string") return false;
  return (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

function statusDir(status: ProposalStatus): string {
  switch (status) {
    case "draft":
      return getProposalsDraftRoot();
    case "pending":
      return getProposalsPendingRoot();
    case "inprogress":
      return getProposalsInProgressRoot();
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

async function listProposalsByStatuses(statuses: readonly ProposalStatus[]): Promise<AnyProposal[]> {
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

export async function listAllProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(ALL_STATUSES);
}

export async function listActiveProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["draft", "inprogress", "committing"]);
}

export async function listDraftProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["draft"]);
}

export async function listPendingProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["pending"]);
}

export async function listInProgressProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["inprogress"]);
}

export async function listCommittingProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["committing"]);
}

export async function listCommittedProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["committed"]);
}

export async function listWithdrawnProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["withdrawn"]);
}

export async function findDraftProposalByWriter(writerId: string): Promise<AnyProposal | null> {
  const drafts = await listDraftProposals();
  return drafts.find((p) => p.writer.id === writerId) ?? null;
}

export async function countDraftsByWriter(writerId: string): Promise<number> {
  const drafts = await listDraftProposals();
  return drafts.filter((p) => p.writer.id === writerId).length;
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
  if (status !== "draft" && status !== "pending" && status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot update proposal ${id}: status is ${status}, expected draft, pending, or inprogress.`,
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

// ─── Lock acquisition (draft → inprogress) ────────────────────────

export interface LockAcquisitionResult {
  acquired: boolean;
  proposal?: InProgressProposal;
  reason?: string;
  section?: ProposalSection;
}

/**
 * Attempt to transition a human draft proposal to inprogress by acquiring
 * section locks. Fails atomically if ANY targeted section has:
 *   1. Active CRDT edit authority (someone editing in real-time)
 *   2. Dirty session overlap (unsaved edits pending commit)
 *   3. Another human inprogress proposal holding it
 *
 * Only human proposals may acquire locks. Agent proposals never enter inprogress.
 */
export async function transitionToInProgress(id: ProposalId): Promise<LockAcquisitionResult> {
  const proposal = await readProposal(id);

  if (proposal.status !== "draft") {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to inprogress: status is ${proposal.status}, expected draft.`,
    );
  }

  if (proposal.writer.type !== "human") {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to inprogress: only human proposals may acquire locks.`,
    );
  }
  if (proposal.sections.length === 0) {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to inprogress: select at least one section.`,
    );
  }

  // Dynamic import to avoid circular dependency (section-presence → proposal-repository)
  const { SectionPresence } = await import("../domain/section-presence.js");

  // Pre-fetch dirty file sets grouped by doc path
  const docPaths = [...new Set(proposal.sections.map(s => s.doc_path))];
  const dirtyFileSets = new Map<string, Set<string>>();
  for (const docPath of docPaths) {
    dirtyFileSets.set(docPath, await SectionPresence.prefetchDirtyFiles(docPath));
  }

  // Pre-fetch inprogress human proposal locks (excluding this proposal)
  const inProgressLocks = await prefetchInProgressLocks(id);

  // Atomic check: all sections must be free
  for (const section of proposal.sections) {
    const ref = SectionRef.fromTarget(section);

    // Check 1: Active CRDT editing session
    if (SectionPresence.checkLiveSessionOnly(ref)) {
      return { acquired: false, reason: "Section is being actively edited", section };
    }

    // Check 2: Dirty session files
    const dirtySet = dirtyFileSets.get(section.doc_path) ?? new Set();
    if (dirtySet.has(ref.key)) {
      return { acquired: false, reason: "Section has unsaved edits pending commit", section };
    }

    // Check 3: Another human inprogress proposal
    const lock = inProgressLocks.get(ref.globalKey);
    if (lock) {
      return { acquired: false, reason: `Section is locked by ${lock.writerDisplayName}`, section };
    }
  }

  // All checks passed — write enriched meta.json then atomic rename
  const now = new Date().toISOString();
  const { status: _s, ...rest } = proposal;
  const file: InProgressProposalFile = {
    ...rest,
    locked_sections: proposal.sections,
    locked_at: now,
  };

  await writeJsonFile(proposalPath("draft", id), file);

  const fromDir = proposalDir("draft", id);
  const toDir = proposalDir("inprogress", id);
  await mkdir(statusDir("inprogress"), { recursive: true });
  await rename(fromDir, toDir);

  return { acquired: true, proposal: { ...file, status: "inprogress" } };
}

/**
 * Scan inprogress proposals to build a lock index.
 * Used by lock acquisition to check for conflicts with other held locks.
 */
async function prefetchInProgressLocks(
  excludeProposalId: string,
): Promise<Map<string, { writerId: string; writerDisplayName: string }>> {
  const index = new Map<string, { writerId: string; writerDisplayName: string }>();
  const inProgressProposals = await listInProgressProposals();
  for (const proposal of inProgressProposals) {
    if (proposal.writer.type !== "human") continue;
    if (proposal.id === excludeProposalId) continue;
    for (const section of proposal.sections) {
      const key = SectionRef.fromTarget(section).globalKey;
      index.set(key, {
        writerId: proposal.writer.id,
        writerDisplayName: proposal.writer.displayName,
      });
    }
  }
  return index;
}

// ─── Standard state transitions ────────────────────────────────────

export async function transitionToCommitting(id: ProposalId): Promise<AnyProposal> {
  const proposal = await readProposal(id);

  // Human proposals must go through inprogress (lock acquisition) before committing.
  // "pending" is always allowed: transient proposals (import, restore, etc.) start there.
  // Agent proposals proceed directly from draft or pending.
  const isHuman = proposal.writer.type === "human";
  const validSourceStatuses = isHuman
    ? ["inprogress", "pending"]
    : ["draft", "pending"];

  if (!validSourceStatuses.includes(proposal.status)) {
    const expected = validSourceStatuses.join(" or ");
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to committing: status is ${proposal.status}, expected ${expected}.`,
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
  if (proposal.status !== "draft" && proposal.status !== "pending" && proposal.status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot withdraw proposal ${id}: status is ${proposal.status}, expected draft, pending, or inprogress.`,
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
