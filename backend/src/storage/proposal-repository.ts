import path from "node:path";
import crypto from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { pathExists, readDirentsIfExists } from "./fs-primitives.js";
import { SectionRef } from "../domain/section-ref.js";
import { mintProposalManifest, unionDeletedSectionFiles, type ProposalManifest } from "./proposal-manifest.js";
import { normalizeDocPath } from "./path-utils.js";
import { parseJson, sectionsToTargets, TERMINAL_PROPOSAL_STATUSES } from "../types/shared.js";
import { decodeProposal, decodeInProgressProposal, readLandedCommittedHead } from "./proposal-file-decoder.js";
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
  DeletedSectionFileRef,
  DocSessionId,
  InProgressProposal,
  InProgressProposalFile,
  ProposalFileBase,
  ProposalId,
  ProposalLockResult,
  ProposalSection,
  ProposalStatus,
  ProposalTargetRef,
  HumanInvolvementCommittedProposalMetadata,
  WithdrawnProposalFile,
  WriterIdentity,
} from "../types/shared.js";

export class ProposalNotFoundError extends Error {}
export class InvalidProposalStateError extends Error {}

/**
 * A proposal claims a section in its `meta.json` manifest but that section's body
 * cannot be read from the proposal content tree (corruption / stale metadata).
 * Single-subject reads FAIL LOUD with this rather than silently dropping the
 * section (claim-review 04: errors must always be surfaced, never coerced away).
 */
export class ProposalIntegrityError extends Error {
  constructor(public readonly proposalId: ProposalId, public readonly sectionKey: string, cause?: unknown) {
    super(
      `Proposal ${proposalId} claims section "${sectionKey}" but its body is missing or unreadable in the proposal content tree` +
      (cause instanceof Error ? `: ${cause.message}` : "") + ".",
    );
    this.name = "ProposalIntegrityError";
  }
}

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

/**
 * Read + decode a proposal `meta.json` into its domain object. The `status` is
 * the directory-discovered lifecycle state (never read from JSON). Decoding is
 * the trust boundary (see {@link decodeProposal}): a malformed/invalid file throws.
 */
async function readProposalFile(filePath: string, status: ProposalStatus): Promise<AnyProposal> {
  const content = await readFile(filePath, "utf8");
  return decodeProposal(parseJson(content), status);
}

/**
 * Lifecycle states where a proposal's `targets` becomes the permanent,
 * load-bearing lock/audit claim — the COMMIT boundary. The restored
 * crash-on-corruption lives here: a proposal still carrying a `degraded` marker
 * (a legacy file read leniently, whose `targets` were DERIVED from `sections`
 * and are lossy in the dangerous direction — a document-level claim cannot be
 * expressed as section claims) must NOT be baked into the permanent committed
 * record. It has to be autofixed first (which re-derives + clears the marker).
 *
 * Note the guard is on `degraded`, NOT on empty `targets`: a zero-section
 * document-level proposal legitimately has empty `targets` and is committable,
 * and draft / pending / CRDT-`inprogress` proposals are legitimately empty
 * containers while their content is assembled. Emptiness is not corruption; an
 * un-repaired lossy derivation is.
 */
const COMMIT_BOUNDARY_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  "committing",
  "committed",
]);

async function writeJsonFile(
  filePath: string,
  data: AnyProposalFile,
  status: ProposalStatus,
): Promise<void> {
  if (COMMIT_BOUNDARY_STATUSES.has(status) && data.degraded !== undefined && data.degraded.length > 0) {
    throw new Error(
      `Refusing to commit proposal ${data.id} to ${filePath}: it is degraded [${data.degraded.join(", ")}]. ` +
        `A degraded proposal carries derived, possibly-lossy \`targets\` and must be autofixed ` +
        `(re-deriving \`targets\` and clearing the marker) before it can be committed — never persisted as-is.`,
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function locateProposal(id: ProposalId): Promise<{ status: ProposalStatus; filePath: string }> {
  for (const status of ALL_STATUSES) {
    const filePath = proposalPath(status, id);
    if (await pathExists(filePath)) {
      return { status, filePath };
    }
  }
  throw new ProposalNotFoundError(`Proposal not found: ${id}`);
}

/**
 * Project a decoded proposal domain object back to its on-disk file shape by
 * dropping the directory-derived `status` (which is NEVER stored in `meta.json`).
 * Returns a fresh object; the input is not mutated.
 */
function proposalToFile(proposal: AnyProposal): AnyProposalFile {
  const { status: _status, ...file } = proposal;
  return file;
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
    targets: sectionsToTargets(sections ?? []),
    created_at: now,
  };
  const contentRoot = proposalContentRoot(id, "draft");
  await mkdir(contentRoot, { recursive: true });
  await writeJsonFile(proposalPath("draft", id), file, "draft");
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
    targets: sectionsToTargets(sections ?? []),
    created_at: now,
  };
  const contentRoot = proposalContentRoot(id, "pending");
  await mkdir(contentRoot, { recursive: true });
  await writeJsonFile(proposalPath("pending", id), file, "pending");
  return { id, contentRoot };
}

export async function readProposal(id: ProposalId): Promise<AnyProposal> {
  for (const status of ALL_STATUSES) {
    const filePath = proposalPath(status, id);
    // Absence in this status dir is a normal lookup miss; a present-but-corrupt
    // meta.json must surface (decoding throws, not a silent miss).
    if (!(await pathExists(filePath))) continue;
    return readProposalFile(filePath, status);
  }
  throw new ProposalNotFoundError(`Proposal not found: ${id}`);
}

/**
 * Record canonical section-file ids this proposal has DELETED (identity-based
 * delete detection). Appends + dedupes into the grow-only `deleted_section_files`
 * field for `docPath`; `sections`/`targets` are left untouched (a deleted section
 * keeps its path claim there for lock/audit). The other manifest writers spread
 * `...current`, so the field they don't manage survives their writes. A no-op for
 * an empty id list. Allowed on non-terminal statuses only (a committed/withdrawn
 * proposal is immutable).
 */
export async function recordDeletedSectionFiles(
  proposalId: ProposalId,
  docPath: string,
  sectionFiles: string[],
): Promise<void> {
  if (sectionFiles.length === 0) return;
  const { status, filePath } = await locateProposal(proposalId);
  if (status !== "draft" && status !== "pending" && status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot record deleted section files for ${proposalId}: status is ${status}, expected draft, pending, or inprogress.`,
    );
  }
  const current = await readProposalFile(filePath, status);
  const normalized = normalizeDocPath(docPath);
  const added: DeletedSectionFileRef[] = sectionFiles.map((section_file) => ({
    doc_path: normalized,
    section_file,
  }));
  const updated: AnyProposalFile = {
    ...proposalToFile(current),
    deleted_section_files: unionDeletedSectionFiles(current.deleted_section_files ?? [], added),
  };
  await writeJsonFile(filePath, updated, status);
}

/**
 * Load the set of canonical section-file ids this proposal has deleted for
 * `docPath` (identity-based delete detection). This is the merge's delete
 * discriminator — a canonical section whose `sectionFile` id is in this set is
 * dropped (deleted), everything else is inherited. Absent field → empty set.
 */
export async function loadDeletedSectionFiles(
  proposalId: ProposalId,
  docPath: string,
): Promise<Set<string>> {
  const proposal = await readProposal(proposalId);
  const target = normalizeDocPath(docPath);
  const ids = new Set<string>();
  for (const ref of proposal.deleted_section_files ?? []) {
    if (normalizeDocPath(ref.doc_path) === target) ids.add(ref.section_file);
  }
  return ids;
}

/**
 * Persist an in-place metadata repair for an existing proposal, WITHOUT changing
 * its lifecycle status (no directory rename). Used by the admin defect-autofix
 * surface to write back a proposal whose derived `targets` were re-derived and
 * whose `degraded` marker was cleared. The repair must keep the same status as
 * the on-disk proposal (this is not a transition path). The write goes through
 * {@link writeJsonFile}, so the commit-boundary degraded guard still applies — a
 * repair that fails to clear the marker is rejected rather than persisted.
 */
export async function rewriteProposalMeta(id: ProposalId, repaired: AnyProposal): Promise<AnyProposal> {
  const { status, filePath } = await locateProposal(id);
  if (repaired.status !== status) {
    throw new InvalidProposalStateError(
      `Cannot rewrite proposal ${id} meta: repaired status is ${repaired.status}, but on disk it is ${status}. ` +
        `In-place repair must not change lifecycle status.`,
    );
  }
  await writeJsonFile(filePath, proposalToFile(repaired), status);
  // Re-decode for the typed return (also round-trip-validates the written file).
  return readProposalFile(filePath, status);
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
 *
 * FAIL LOUD (claim-review 04): this is a SINGLE-SUBJECT read. A section the
 * manifest claims whose body is missing/unreadable is CORRUPTION — it throws
 * `ProposalIntegrityError` rather than silently dropping the section. Every
 * claimed section therefore resolves (or the whole read fails), so callers can
 * drop their `?? null` / `?? ""` coercions over a missing entry.
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
      if (err instanceof SectionNotFoundError || err instanceof DocumentNotFoundError) {
        // A manifest-claimed section with no readable body is corruption — surface
        // it, do NOT continue past it.
        throw new ProposalIntegrityError(id, ref.globalKey, err);
      }
      throw err;
    }
  }

  return { proposal, sectionContent };
}

export async function listProposalsByStatuses(statuses: readonly ProposalStatus[]): Promise<AnyProposal[]> {
  const proposals: AnyProposal[] = [];

  for (const currentStatus of statuses) {
    // An absent status directory means no proposals in that status.
    const entries = await readDirentsIfExists(statusDir(currentStatus));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      // A proposal directory without a meta.json is skipped; a present-but-corrupt
      // meta.json surfaces (decoding throws).
      const metaPath = path.join(statusDir(currentStatus), entry.name, "meta.json");
      if (!(await pathExists(metaPath))) continue;
      proposals.push(await readProposalFile(metaPath, currentStatus));
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

/**
 * The proposals an admin needs to tend to: those still carrying a `degraded`
 * marker. Scans ONLY the degradable (non-terminal) statuses — a terminal
 * proposal is never tagged degraded (see the decoder), and reading the full
 * committed/withdrawn history just to filter it out would be a needless
 * full-history decode. This is the focused query behind the home-page alert.
 */
export async function listDegradedProposals(): Promise<AnyProposal[]> {
  const degradableStatuses = ALL_STATUSES.filter((s) => !TERMINAL_PROPOSAL_STATUSES.has(s));
  const proposals = await listProposalsByStatuses(degradableStatuses);
  return proposals.filter((p) => p.degraded !== undefined && p.degraded.length > 0);
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

/**
 * Replace a proposal's `sections` manifest. The manifest is BRAND-GATED: it can
 * only be a `ProposalManifest` produced by the `mutateProposalContent(...)`
 * boundary (or the explicit recovery escape hatch below), never a raw
 * `ProposalSection[]` hand-built from request parameters (spec 12 §Proposal FSM
 * locking — the manifest is the lock/policy/audit/event claim set and must be
 * derived from the authoritative mutation result). See {@link ProposalManifest}.
 */
export async function updateProposalSections(
  id: ProposalId,
  manifest: ProposalManifest,
  intent?: string,
): Promise<UpdateProposalResult> {
  return writeProposalSectionsFile(id, manifest, intent);
}

/**
 * Low-level escape hatch: replace a proposal's `sections` manifest from a RAW
 * array, bypassing the `mutateProposalContent(...)` boundary. NARROWLY justified
 * for recovery / bootstrap / CRDT-internal callers that legitimately own their
 * own manifest derivation (e.g. restore's replay+deleted merge, the CRDT
 * generator's live-edit manifest growth) and are not application/MCP request
 * handlers. Application and MCP code MUST NOT call this — use
 * `mutateProposalContent(...)` instead.
 */
export async function unsafeReplaceProposalManifestForRecoveryOnly(
  id: ProposalId,
  sections: ProposalSection[],
  intent?: string,
  extraTargets: ProposalTargetRef[] = [],
): Promise<UpdateProposalResult> {
  return writeProposalSectionsFile(id, mintProposalManifest(sections, extraTargets), intent);
}

/**
 * Declare a proposal's `sections` from a human/agent DRAFT RESERVATION request.
 * This is the one legitimate caller-DECLARED manifest: a human reservation (spec
 * 12 §Human reservations) explicitly selects the section scope it intends to edit
 * (and which it will hold locks over), so the manifest IS the declaration, not a
 * structural-mutation result. Distinct from the recovery hatch above and from the
 * `mutateProposalContent(...)` boundary. The lock-scope invariant (no scope change
 * while `inprogress`) is enforced by the caller before this is called. Application
 * code may call ONLY this for the reservation-modify path — all structural content
 * mutations MUST go through `mutateProposalContent(...)`.
 */
export async function declareReservedProposalSectionsFromRequest(
  id: ProposalId,
  sections: ProposalSection[],
  intent?: string,
): Promise<UpdateProposalResult> {
  return writeProposalSectionsFile(id, mintProposalManifest(sections), intent);
}

async function writeProposalSectionsFile(
  id: ProposalId,
  manifest: ProposalManifest,
  intent?: string,
): Promise<UpdateProposalResult> {
  const { status, filePath } = await locateProposal(id);
  if (status !== "draft" && status !== "pending" && status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot update proposal ${id}: status is ${status}, expected draft, pending, or inprogress.`,
    );
  }
  // Immutable update: build a fresh file object from the decoded current proposal.
  const current = await readProposalFile(filePath, status);
  const file: AnyProposalFile = {
    ...proposalToFile(current),
    sections: [...manifest.sections],
    targets: [...manifest.targets],
    ...(intent !== undefined ? { intent } : {}),
  };
  await writeJsonFile(filePath, file, status);
  const contentRoot = proposalContentRoot(id, status);
  // Re-decode for the typed return (also round-trip-validates the written file).
  return { proposal: await readProposalFile(filePath, status), contentRoot };
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
  if (proposal.targets.length === 0) {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to inprogress: select at least one target.`,
    );
  }
  if (proposal.degraded !== undefined && proposal.degraded.length > 0) {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to inprogress: it is degraded [${proposal.degraded.join(", ")}] ` +
        `and carries derived, possibly-lossy targets. Autofix it before it can acquire locks.`,
    );
  }

  // Dynamic import to avoid circular dependency
  // (proposal-fsm-locks → proposal-fsm-lock-index → proposal-repository).
  const { checkProposalLocks } = await import("../domain/proposal-fsm-locks.js");

  const lockResult = await checkProposalLocks({
    proposalId: id,
    targets: proposal.targets,
  });

  if (!lockResult.acquired) {
    // All-or-nothing: remain draft, return the full conflict result.
    return { ...lockResult };
  }

  // All checks passed — write meta.json then atomic rename. `targets` is the
  // authoritative claim set; no separate lock mirror is stored.
  const { status: _s, ...rest } = proposal;
  const file: InProgressProposalFile = { ...rest };

  await writeJsonFile(proposalPath("draft", id), file, "draft");

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

  // Quarantine gate: a degraded proposal (legacy file whose `targets` were
  // derived from `sections` and are lossy in the dangerous direction) must be
  // autofixed before commit, never baked into the permanent committed record.
  // EVERY commit passes through here, so this is the single domain-level refusal
  // (the storage write boundary backstops it). Mirrors the empty-targets /
  // degraded refusal in {@link transitionToInProgress}.
  if (proposal.degraded !== undefined && proposal.degraded.length > 0) {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to committing: it is degraded [${proposal.degraded.join(", ")}] ` +
        `and carries derived, possibly-lossy targets. Autofix it before it can be committed.`,
    );
  }

  // MANDATORY exclusive-claim gate (spec 12 §Transition Semantics): EVERY commit
  // passes through here — agent/human/CRDT/restore/overwrite/import/structural
  // alike. Before claiming `committing`, assert no OTHER proposal holds an
  // exclusive lock (`inprogress`/`committing`) on this proposal's full target set.
  // There is no bypass / forced-operation flag: a forced flow must stage a
  // complete manifest and pass this same gate. Self-exclusion (excludeProposalId)
  // lets a proposal's own `inprogress`/`pending` claim progress to `committing`
  // without blocking itself. On conflict this throws `ProposalLockConflictError`
  // (carrying the full conflict result) BEFORE any directory rename, so the
  // proposal is left untouched in its source status.
  //
  // Dynamic import avoids the circular dependency
  // (proposal-fsm-locks → proposal-fsm-lock-index → proposal-repository).
  const { assertProposalLocksAvailable } = await import("../domain/proposal-fsm-locks.js");
  await assertProposalLocksAvailable({
    proposalId: id,
    targets: proposal.targets,
  });

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
  await writeJsonFile(proposalPath("committing", id), file, "committing");

  // Atomic directory rename
  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("committed", id);
  await mkdir(statusDir("committed"), { recursive: true });
  await rename(fromDir, toDir);

  return { ...file, status: "committed" };
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
  if (!(await pathExists(filePath))) {
    throw new ProposalNotFoundError(`Committing proposal not found: ${id}`);
  }
  const json = parseJson(await readFile(filePath, "utf8"));

  // Recovery-only local check: was the canonical commit already landed (the
  // crash-before-rename case)? This check does not pollute the normal domain type.
  const committedHead = readLandedCommittedHead(json);
  if (committedHead === null) {
    return null;
  }

  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("committed", id);
  await mkdir(statusDir("committed"), { recursive: true });
  await rename(fromDir, toDir);

  // The committing file already carries the full committed metadata (written
  // before the rename), so it decodes cleanly as a committed proposal.
  return decodeProposal(json, "committed");
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
  await writeJsonFile(proposalPath(proposal.status, id), file, proposal.status);

  // Atomic directory rename
  const fromDir = proposalDir(proposal.status, id);
  const toDir = proposalDir("withdrawn", id);
  await mkdir(statusDir("withdrawn"), { recursive: true });
  await rename(fromDir, toDir);

  if (proposal.writer.type === "agent") {
    const { agentEventLog } = await import("../mcp/agent-event-log.js");
    agentEventLog.append(proposal.writer, { kind: "proposal_withdrawn", proposalId: id });
  }
  return { ...file, status: "withdrawn" };
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
  // The committing meta.json was carried unchanged from inprogress; restore the
  // inprogress projection from disk (committing/inprogress share the base shape).
  const json = parseJson(await readFile(filePath, "utf8"));

  const fromDir = proposalDir("committing", id);
  const toDir = proposalDir("inprogress", id);
  await mkdir(statusDir("inprogress"), { recursive: true });
  await rename(fromDir, toDir);

  return decodeInProgressProposal(json);
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
  return match !== undefined && match.status === "inprogress" ? match : null;
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
    (proposal): proposal is InProgressProposal =>
      proposal.status === "inprogress"
      && proposal.docSessionId !== undefined
      && proposal.sections.some((section) => section.doc_path === docPath),
  );
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
  const targets = sectionsToTargets(sections);
  const file: InProgressProposalFile = {
    id,
    writer: input.writer,
    intent: input.intent ?? "",
    sections,
    targets,
    created_at: now,
    docSessionId: input.docSessionId,
  };

  const contentRoot = proposalContentRoot(id, "inprogress");
  await mkdir(contentRoot, { recursive: true });
  await writeJsonFile(proposalPath("inprogress", id), file, "inprogress");

  return { id, contentRoot, proposal: { ...file, status: "inprogress" } };
}

/**
 * Update the section manifest of a CRDT-owned `inprogress` proposal as its live
 * content tree grows. Distinct from {@link updateProposalSections}: it keeps
 * `targets` in sync with `sections` for a DocSession-owned `inprogress` proposal
 * (live editing is section-only, so the claim set is the section targets).
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
  const current = await readProposalFile(filePath, "inprogress");
  if (current.status !== "inprogress") {
    throw new InvalidProposalStateError(`Proposal ${id} is not inprogress as located.`);
  }
  // Immutable update: fresh object, no mutation of the decoded input.
  const updated: InProgressProposal = {
    ...current,
    sections,
    targets: sectionsToTargets(sections),
    ...(intent !== undefined ? { intent } : {}),
  };
  await writeJsonFile(filePath, proposalToFile(updated), status);
  return updated;
}

/**
 * MONOTONICALLY grow a CRDT-owned `inprogress` proposal's section manifest as the
 * live document is edited (C4): UNION `addSections` into the existing `sections`,
 * deduped by section global key. The manifest is GROW-ONLY (D6) — it never shrinks.
 * A delete does NOT drop a section from `sections`: deletes are tracked by stable
 * canonical section-file id in `deleted_section_files` (identity-based delete
 * detection), so the manifest stays a pure grow-only lock/audit claim set and the
 * structural merge keys delete-vs-inherit on the id set, not on a manifest path.
 * `targets` is kept identical to the section targets of `sections` (live editing is
 * section-only; see assumptions.md C4).
 */
export async function unionCurrentProposalSections(
  id: ProposalId,
  addSections: ProposalSection[],
): Promise<InProgressProposal> {
  const { status, filePath } = await locateProposal(id);
  if (status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot union current-proposal sections for ${id}: status is ${status}, expected inprogress.`,
    );
  }
  const current = await readProposalFile(filePath, "inprogress");
  if (current.status !== "inprogress") {
    throw new InvalidProposalStateError(`Proposal ${id} is not inprogress as located.`);
  }

  const merged: ProposalSection[] = [];
  const seen = new Set<string>();
  for (const section of [...current.sections, ...addSections]) {
    const key = SectionRef.fromTarget(section).globalKey;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(section);
  }

  // Immutable update: fresh object, no mutation of the decoded input.
  const updated: InProgressProposal = {
    ...current,
    sections: merged,
    targets: sectionsToTargets(merged),
  };
  await writeJsonFile(filePath, proposalToFile(updated), status);
  return updated;
}
