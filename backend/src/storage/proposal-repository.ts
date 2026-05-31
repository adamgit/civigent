import path from "node:path";
import crypto from "node:crypto";
import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
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
  DocSessionId,
  InProgressProposal,
  InProgressProposalFile,
  ProposalFileBase,
  ProposalId,
  ProposalLockResult,
  ProposalSection,
  ProposalStatus,
  HumanInvolvementCommittedProposalMetadata,
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

/**
 * Returns true if the proposal is CRDT-owned — i.e. a live-edit proposal
 * lazily materialized by a DocSession actor (Area B/F), keyed on its owning
 * `docSessionId`. These are SYSTEM artefacts mutated internally by the
 * DocSession actor (spec 10 "One active proposal per DocSession"), NOT
 * agent-authored proposals. The `docSessionId` discriminator is required: a
 * human `draft→inprogress` lock proposal also has status `inprogress` but
 * carries no `docSessionId`, and is a real authored proposal that must remain
 * visible. Agent-facing MCP listings/reads must hide CRDT-owned proposals so
 * they are not a live-state side channel.
 */
export function isCrdtOwnedProposal(proposal: AnyProposal): boolean {
  return proposal.docSessionId !== undefined;
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

function proposalCreatedAtTimestamp(proposal: AnyProposal): number {
  const timestamp = Date.parse(proposal.created_at);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareProposalsNewestFirst(a: AnyProposal, b: AnyProposal): number {
  const timestampDelta = proposalCreatedAtTimestamp(b) - proposalCreatedAtTimestamp(a);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return a.id.localeCompare(b.id);
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
 * Read a proposal and its section content through the proposal facade.
 * Returns the proposal metadata and a separate content map (keyed by the
 * SectionRef global key "doc_path::heading>path"). Content lives on disk,
 * never on the section objects.
 *
 * Routed through `ProposalReader` (effective proposal-content read path)
 * rather than reaching into the content store directly. The dynamic import
 * breaks the proposal-reader -> proposal-repository -> proposal-reader cycle.
 * Sections whose effective bodies are missing are silently omitted, matching
 * the previous `readSectionBatch` behavior.
 */
export async function readProposalWithContent(id: ProposalId): Promise<{ proposal: AnyProposal; sectionContent: Map<string, string> }> {
  const proposal = await readProposal(id);
  const { ProposalReader } = await import("./proposal-reader.js");
  const { SectionNotFoundError, DocumentNotFoundError } = await import("./content-layer.js");
  const reader = ProposalReader.open(id, proposal.status);

  const sectionContent = new Map<string, string>();
  for (const section of proposal.sections) {
    const ref = SectionRef.fromTarget(section);
    try {
      const body = await reader.readSection(ref.docPath, ref.headingPath);
      sectionContent.set(ref.globalKey, body);
    } catch (err) {
      if (err instanceof SectionNotFoundError || err instanceof DocumentNotFoundError) continue;
      throw err;
    }
  }

  return { proposal, sectionContent };
}

export async function listProposalsByStatuses(statuses: readonly ProposalStatus[]): Promise<AnyProposal[]> {
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

  proposals.sort(compareProposalsNewestFirst);
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

/**
 * Result of a human `draft -> inprogress` lock-acquisition transition.
 *
 * Aligned with {@link ProposalLockResult}: `acquired` + full `conflicts[]`
 * (each with blocking proposal id/status/writer + prose `message`) + top-level
 * prose `message`. On success, `proposal` carries the now-`inprogress` proposal.
 * The legacy bare `{ reason, section }` shape is gone.
 */
export interface LockAcquisitionResult extends ProposalLockResult {
  proposal?: InProgressProposal;
}

/**
 * Attempt to transition a human draft proposal to inprogress by acquiring
 * exclusive section locks via the proposal FSM lock subsystem.
 *
 * Exclusion is enforced ONLY against other proposals' exclusive claims
 * (`inprogress` + `committing`) — there is no dirty-file / live-focus check.
 * All-or-nothing: if ANY targeted section conflicts, the proposal remains
 * `draft` and the full {@link ProposalLockResult} (all conflicts + prose) is
 * returned. Only human proposals may acquire locks; agent proposals never
 * enter inprogress.
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

  // Dynamic import to avoid circular dependency
  // (proposal-fsm-locks → proposal-fsm-lock-index → proposal-repository).
  const { checkProposalLocks } = await import("../domain/proposal-fsm-locks.js");

  const lockResult = await checkProposalLocks({
    proposalId: id,
    targets: proposal.sections.map((section) => ({
      doc_path: section.doc_path,
      heading_path: section.heading_path,
    })),
  });

  if (!lockResult.acquired) {
    // All-or-nothing: remain draft, return the full conflict result.
    return { ...lockResult };
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

  return { ...lockResult, proposal: { ...file, status: "inprogress" } };
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
  committedMetadata: HumanInvolvementCommittedProposalMetadata,
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
  const file: CommittedProposalFile = { ...rest, committed_head: committedHead, humanInvolvement_at_commit: committedMetadata };
  await writeJsonFile(proposalPath("committing", id), file);

  // Atomic directory rename
  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("committed", id);
  await mkdir(statusDir("committed"), { recursive: true });
  await rename(fromDir, toDir);

  return toProposal(file, "committed");
}

/**
 * Startup-recovery-only: finalize a `committing` proposal whose `meta.json`
 * already carries an enriched `committed_head` (the crash-before-rename case
 * noted on {@link transitionToCommitted}: the enriched meta is written BEFORE
 * the atomic dir rename, so a crash between the two leaves a `committing`
 * proposal whose canonical commit has ALREADY landed).
 *
 * Reads the committing `meta.json`; if it carries a non-empty `committed_head`,
 * performs the atomic `committing` -> `committed` directory rename without
 * re-deriving scores or re-running canonical absorb (the delta already landed).
 * Returns the promoted proposal, or `null` if `committed_head` is absent (the
 * commit had not landed — caller must rerun publication instead).
 *
 * Status-by-directory FSM preserved; nothing about `meta.json` is rewritten
 * (the enriched fields are already on disk); `status` is never stored.
 * MUST NOT be used outside crash recovery.
 */
export async function finalizeCommittingProposal(id: ProposalId): Promise<AnyProposal | null> {
  const filePath = proposalPath("committing", id);
  let file: AnyProposalFile;
  try {
    file = await readJsonFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProposalNotFoundError(`Committing proposal not found: ${id}`);
    }
    throw error;
  }

  const committedHead = (file as Partial<CommittedProposalFile>).committed_head;
  if (typeof committedHead !== "string" || committedHead.length === 0) {
    return null;
  }

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

/**
 * Roll a `committing` proposal back to `draft` after a RUNTIME publish failure
 * for an agent-owned proposal (spec 02 › "Why `committing` as a transient guard
 * state": agent → `draft`, human/DocSession → `inprogress`).
 *
 * MUST NOT be called from startup crash recovery — recovery finalizes
 * (`finalizeCommittingProposal`) or reruns publication
 * (`publishCommittingProposalToCanonical`) and never rolls a `committing`
 * proposal back to `draft`/`inprogress`.
 */
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

/**
 * Return a `committing` proposal to `inprogress` after a runtime publish failure.
 *
 * Per spec 02 "Why `committing` as a transient guard state", a human / DocSession
 * proposal that fails to publish keeps its locks and returns to `inprogress`
 * (the DocSession remains its current proposal) rather than dropping to `draft`.
 * The `committing` directory carried no extra runtime metadata beyond the
 * inprogress lock fields, so this is a pure directory rename.
 */
export async function rollbackCommittingToInProgress(id: ProposalId): Promise<InProgressProposal> {
  const { status, filePath } = await locateProposal(id);
  if (status !== "committing") {
    throw new InvalidProposalStateError(
      `Cannot rollback proposal ${id}: status is ${status}, expected committing.`,
    );
  }
  // The committing meta.json was carried unchanged from inprogress and still
  // holds the lock fields; restore the inprogress projection from disk.
  const file = (await readJsonFile(filePath)) as InProgressProposalFile;

  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("inprogress", id);
  await mkdir(statusDir("inprogress"), { recursive: true });
  await rename(fromDir, toDir);

  return { ...file, status: "inprogress" };
}

/**
 * Caller context for runtime `committing`-failure rollback (spec 02 transient
 * guard state). Agent proposals roll back to `draft`; human/DocSession proposals
 * return to `inprogress`. Startup recovery (finalize-if-landed / rerun-absorb)
 * is Area E's driver and does NOT use this — it never rolls back.
 */
export type CommittingRollbackOwnerKind = "agent" | "docsession";

/**
 * Dispatch a runtime `committing`-failure rollback to the correct target based
 * on caller context. The publish path (commit-pipeline / CRDTProposalGenerator,
 * Areas C/B) threads `ownerKind`; Area F only owns the repository transitions.
 */
export async function rollbackCommittingProposal(
  id: ProposalId,
  ownerKind: CommittingRollbackOwnerKind,
): Promise<AnyProposal> {
  return ownerKind === "agent"
    ? rollbackCommittingToDraft(id)
    : rollbackCommittingToInProgress(id);
}

// ─── CRDT-owned lifecycle helpers (live-edit materialization) ──────────
//
// These support Area B's CRDTProposalGenerator: a DocSession lazily creates and
// owns exactly one `inprogress` proposal as live edits materialize. They are
// DELIBERATELY distinct from — and NOT gated by — the human `draft -> inprogress`
// lock acquisition above (Invariant 3): a DocSession-owned `inprogress` proposal
// is created directly, keyed on the passed-in DocSession identity (Area B owns
// the DocSession identity/actor lane; Area F keys on the id string).
//
// One-active-`inprogress`-proposal-per-DocSession is enforced at create time
// (Invariant 7).

/**
 * Find the single CRDT-owned `inprogress` proposal for a DocSession, if one
 * has been materialized. Returns null before the session's first live edit.
 */
export async function findInProgressProposalForDocSession(
  docSessionId: DocSessionId,
): Promise<InProgressProposal | null> {
  const inProgress = await listInProgressProposals();
  const match = inProgress.find(
    (proposal) => proposal.docSessionId === docSessionId,
  );
  return (match as InProgressProposal | undefined) ?? null;
}

/**
 * Find the CRDT-owned `inprogress` proposal targeting a given doc path, if any.
 * Convenience lookup for the live-edit boundary; a DocSession owns one document.
 */
export async function findInProgressProposalForDoc(
  docPath: string,
): Promise<InProgressProposal | null> {
  const matches = await listInProgressProposalsForDoc(docPath);
  return matches[0] ?? null;
}

/**
 * All CRDT-owned `inprogress` proposals targeting a given doc path. The
 * one-active-proposal-per-DocSession invariant means this should never return
 * more than one entry; callers (e.g. DocSession reconstruction) use the length
 * to detect — and refuse rather than silently pick from — a corrupt
 * multiple-proposal state.
 */
export async function listInProgressProposalsForDoc(
  docPath: string,
): Promise<InProgressProposal[]> {
  const inProgress = await listInProgressProposals();
  return inProgress.filter(
    (proposal) =>
      proposal.docSessionId !== undefined
      && proposal.sections.some((section) => section.doc_path === docPath),
  ) as InProgressProposal[];
}

/**
 * Lazily create (or return the existing) single CRDT-owned `inprogress` proposal
 * for a DocSession. Writes meta.json + content/ directly under
 * proposals/inprogress (bypassing the human draft→inprogress lock path).
 *
 * Enforces one active proposal per DocSession (Invariant 7): if the session
 * already owns an `inprogress` proposal, that one is returned unchanged.
 */
export async function getOrCreateInProgressProposalForDocSession(input: {
  docSessionId: DocSessionId;
  docPath: string;
  writer: WriterIdentity;
  intent?: string;
  sections?: ProposalSection[];
}): Promise<CreateProposalResult & { proposal: InProgressProposal }> {
  const existing = await findInProgressProposalForDocSession(input.docSessionId);
  if (existing) {
    return {
      id: existing.id,
      contentRoot: proposalContentRoot(existing.id, "inprogress"),
      proposal: existing,
    };
  }

  const id = generateProposalId();
  const now = new Date().toISOString();
  const sections = input.sections ?? [];
  const file: InProgressProposalFile = {
    id,
    writer: input.writer,
    intent: input.intent ?? "",
    sections,
    created_at: now,
    docSessionId: input.docSessionId,
    locked_sections: sections,
    locked_at: now,
  };

  const contentRoot = proposalContentRoot(id, "inprogress");
  await mkdir(contentRoot, { recursive: true });
  await writeJsonFile(proposalPath("inprogress", id), file);

  return { id, contentRoot, proposal: { ...file, status: "inprogress" } };
}

/**
 * Update the section manifest (and lock-section mirror) of a CRDT-owned
 * `inprogress` proposal as its live content tree grows. Distinct from
 * {@link updateProposalSections}: it keeps `locked_sections` in sync with
 * `sections` for a DocSession-owned `inprogress` proposal.
 */
export async function updateCurrentProposalSections(
  id: ProposalId,
  sections: ProposalSection[],
  intent?: string,
): Promise<InProgressProposal> {
  const { status, filePath } = await locateProposal(id);
  if (status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot update current-proposal sections for ${id}: status is ${status}, expected inprogress.`,
    );
  }
  const file = (await readJsonFile(filePath)) as InProgressProposalFile;
  file.sections = sections;
  file.locked_sections = sections;
  if (intent !== undefined) file.intent = intent;
  await writeJsonFile(filePath, file);
  return { ...file, status: "inprogress" };
}

/**
 * MONOTONICALLY grow a CRDT-owned `inprogress` proposal's section manifest as the
 * live document is edited (C4): UNION `addSections` into the existing `sections`
 * and DROP `removeSections` (a structural merge folds a section away), then dedup
 * by section global key. This keeps the live proposal's lock claim covering only
 * what has actually been edited this session — NOT the whole document — restoring
 * the section-by-section contention model (a one-section edit must not lock every
 * section against agents). `locked_sections` is kept identical to `sections` (the
 * `sections` field is the authoritative lock-claim set; see assumptions.md C4).
 */
export async function unionCurrentProposalSections(
  id: ProposalId,
  addSections: ProposalSection[],
  removeSections: ProposalSection[] = [],
): Promise<InProgressProposal> {
  const { status, filePath } = await locateProposal(id);
  if (status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot union current-proposal sections for ${id}: status is ${status}, expected inprogress.`,
    );
  }
  const file = (await readJsonFile(filePath)) as InProgressProposalFile;

  // Add wins over remove: a section that is both written and removed in the same
  // delta (e.g. a split whose parent is restructured but survives) stays claimed.
  const addKeys = new Set(addSections.map((s) => SectionRef.fromTarget(s).globalKey));
  const removeKeys = new Set(
    removeSections
      .map((s) => SectionRef.fromTarget(s).globalKey)
      .filter((k) => !addKeys.has(k)),
  );
  const merged: ProposalSection[] = [];
  const seen = new Set<string>();
  for (const section of [...file.sections, ...addSections]) {
    const key = SectionRef.fromTarget(section).globalKey;
    if (removeKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push(section);
  }

  file.sections = merged;
  file.locked_sections = merged;
  await writeJsonFile(filePath, file);
  return { ...file, status: "inprogress" };
}
