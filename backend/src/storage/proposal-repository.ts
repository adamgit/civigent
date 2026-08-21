import path from "node:path";
import crypto from "node:crypto";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { pathExists, readDirentsIfExists } from "./fs-primitives.js";
import { SectionRef } from "../domain/section-ref.js";
import { mintProposalManifest, unionDeletedSectionFiles, type ProposalManifest } from "./proposal-manifest.js";
import {
  DocPath,
  isActiveProposal,
  parseJson,
  proposalDeletedSectionFileDocPathForDisplay,
  proposalSectionClaimsWithParsedDocPaths,
  proposalTargetsParsedForLiveUse,
  sectionGlobalKey,
  sectionsToTargets,
} from "../types/shared.js";
import {
  decodeProposal,
  decodeActiveProposal,
  decodeInProgressProposal,
  proposalJsonAdoptionId,
  proposalJsonClaimsAnyDoc,
  proposalJsonIdOrNull,
  proposalJsonWriterId,
  rawClaimedDocPathsFromProposalJson,
  readLandedCommittedHead,
} from "./proposal-file-decoder.js";
import {
  getContentRoot,
  getProposalsDraftRoot,
  getProposalsPendingRoot,
  getProposalsInProgressRoot,
  getProposalsCommittingRoot,
  getProposalsCommittedRoot,
  getProposalsWithdrawnRoot,
} from "./data-root.js";
import type {
  AnyProposal,
  ActiveProposal,
  ActiveProposalStatus,
  AnyProposalFile,
  CommittedProposalFile,
  DeletedSectionFileRef,
  InProgressProposal,
  InProgressProposalFile,
  ListDegradedProposalsResponse,
  ProposalAdoptionId,
  ProposalFileBase,
  ProposalId,
  ProposalLockResult,
  ProposalReportingUndecodableEntry,
  ProposalSectionClaim,
  ProposalStatus,
  ProposalTargetRef,
  HumanInvolvementCommittedProposalMetadata,
  UndecodableProposalRef,
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
export function isProposalMutable(proposal: AnyProposal): proposal is ActiveProposal {
  if (proposal.status === "draft") return true;
  if (proposal.status === "inprogress" && proposal.writer.type === "human") return true;
  return false;
}

/**
 * Returns true if the proposal is CRDT-owned — i.e. a live-edit proposal
 * lazily materialized by a DocSession actor (Area B/F), keyed on its owning
 * `proposalAdoptionId`. These are SYSTEM artefacts mutated internally by the
 * DocSession actor (spec 10 "One active proposal per DocSession"), NOT
 * agent-authored proposals. The `proposalAdoptionId` discriminator is required: a
 * human `draft→inprogress` lock proposal also has status `inprogress` but
 * carries no `proposalAdoptionId`, and is a real authored proposal that must remain
 * visible. Agent-facing MCP listings/reads must hide CRDT-owned proposals so
 * they are not a live-state side channel.
 */
export function isCrdtOwnedProposal(proposal: AnyProposal): boolean {
  return proposal.proposalAdoptionId !== undefined;
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
 * The effective root pair for skeleton/seed reads of a live document: the
 * `inprogress` proposal overlay when a current proposal exists, else canonical
 * — with the canonical root alongside as the merge base. The CRDT layer
 * (live-section-layout, ydoc-lifecycle) consumes this instead of composing
 * roots from `getContentRoot` itself.
 */
export function effectiveSkeletonRootPair(
  currentProposalId: ProposalId | null,
): { skeletonRoot: string; canonicalRoot: string } {
  const canonicalRoot = getContentRoot();
  return {
    canonicalRoot,
    skeletonRoot: currentProposalId ? proposalContentRoot(currentProposalId, "inprogress") : canonicalRoot,
  };
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

async function readActiveProposalFile(filePath: string, status: ActiveProposalStatus): Promise<ActiveProposal> {
  const content = await readFile(filePath, "utf8");
  return decodeActiveProposal(parseJson(content), status);
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

export async function readRawProposalMeta(
  id: ProposalId,
): Promise<{ status: ProposalStatus; rawMeta: string }> {
  const located = await locateProposal(id);
  return {
    status: located.status,
    rawMeta: await readFile(located.filePath, "utf8"),
  };
}

/**
 * Project a decoded proposal domain object back to its on-disk file shape by
 * dropping the directory-derived `status` (which is NEVER stored in `meta.json`).
 * Returns a fresh object; the input is not mutated.
 */
function proposalToFile(proposal: ActiveProposal): ProposalFileBase {
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
  sections?: ProposalSectionClaim[],
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
  sections?: ProposalSectionClaim[],
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

export async function readActiveProposal(id: ProposalId): Promise<ActiveProposal> {
  const proposal = await readProposal(id);
  if (!isActiveProposal(proposal)) {
    throw new InvalidProposalStateError(
      `Proposal ${id} is in terminal status ${proposal.status}; its stored document paths are historical record and cannot be used as live identity.`,
    );
  }
  return proposal;
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
  docPath: DocPath,
  sectionFiles: string[],
): Promise<void> {
  if (sectionFiles.length === 0) return;
  const { status, filePath } = await locateProposal(proposalId);
  if (status !== "draft" && status !== "pending" && status !== "inprogress") {
    throw new InvalidProposalStateError(
      `Cannot record deleted section files for ${proposalId}: status is ${status}, expected draft, pending, or inprogress.`,
    );
  }
  const current = await readActiveProposalFile(filePath, status);
  const claimedDocPath = DocPath.parse(docPath);
  const added: DeletedSectionFileRef[] = sectionFiles.map((section_file) => ({
    doc_path: claimedDocPath,
    section_file,
  }));
  const updated: ProposalFileBase = {
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
  docPath: DocPath,
): Promise<Set<string>> {
  const proposal = await readProposal(proposalId);
  const target = DocPath.parse(docPath);
  const ids = new Set<string>();
  for (const ref of proposal.deleted_section_files ?? []) {
    if (proposalDeletedSectionFileDocPathForDisplay(ref) === target) {
      ids.add(ref.section_file);
    }
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
export async function rewriteProposalMeta(id: ProposalId, repaired: ActiveProposal): Promise<AnyProposal> {
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

export type ResolvedProposalSectionClaim =
  | { state: "present"; docPath: DocPath; headingPath: string[]; content: string }
  | { state: "absent-at-address"; docPath: DocPath; headingPath: string[] };

/**
 * Resolve every persisted section claim of a proposal through the effective
 * proposal view. Each claim resolves to `"present"` (with its effective body,
 * overlay-first with canonical fallback) or `"absent-at-address"` (the claim's
 * heading address does not exist in the effective structure — which is NOT
 * interpreted as a deletion; deletions are recorded separately in
 * `deleted_section_files`).
 *
 * Routed through `ProposalReader` (effective proposal-content read path)
 * rather than reaching into the content store directly. The dynamic import
 * breaks the proposal-reader -> proposal-repository -> proposal-reader cycle.
 *
 * FAIL LOUD (claim-review 04): a claim whose heading the effective structure
 * declares but whose body exists in neither overlay nor canonical is
 * CORRUPTION — it throws `ProposalIntegrityError` rather than silently
 * dropping the section.
 */
export async function resolveProposalSectionClaims(
  id: ProposalId,
): Promise<{ proposal: AnyProposal; claims: ResolvedProposalSectionClaim[] }> {
  const proposal = await readProposal(id);
  const { ProposalReader } = await import("./proposal-reader.js");
  const { SectionNotFoundError, DocumentNotFoundError } = await import("./content-layer.js");
  const reader = ProposalReader.open(id, proposal.status);

  const claims: ResolvedProposalSectionClaim[] = [];
  for (const section of proposalSectionClaimsWithParsedDocPaths(proposal)) {
    const ref = SectionRef.fromTarget(section);
    try {
      const lookup = await reader.lookupEffectiveSection(ref.docPath, ref.headingPath);
      if (lookup.state === "present") {
        claims.push({
          state: "present",
          docPath: ref.docPath,
          headingPath: ref.headingPath,
          content: lookup.body,
        });
      } else {
        claims.push({
          state: "absent-at-address",
          docPath: ref.docPath,
          headingPath: ref.headingPath,
        });
      }
    } catch (err) {
      if (err instanceof SectionNotFoundError || err instanceof DocumentNotFoundError) {
        throw new ProposalIntegrityError(id, ref.globalKey, err);
      }
      throw err;
    }
  }

  return { proposal, claims };
}

/**
 * Compatibility projection over `resolveProposalSectionClaims`: proposal
 * metadata plus a PARTIAL content map (keyed by the SectionRef global key
 * "doc_path::heading>path") containing only the present claims. Absent
 * claims are simply missing from the map; integrity failures (a structurally
 * declared section whose body exists in neither layer) still throw.
 */
export async function readProposalWithContent(id: ProposalId): Promise<{ proposal: AnyProposal; sectionContent: Map<string, string> }> {
  const { proposal, claims } = await resolveProposalSectionClaims(id);
  const sectionContent = new Map<string, string>();
  for (const claim of claims) {
    if (claim.state !== "present") continue;
    sectionContent.set(new SectionRef(claim.docPath, claim.headingPath).globalKey, claim.content);
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

/**
 * List proposals for UI/agent listing surfaces: decode failures become
 * `undecodable` entries instead of failing the whole list. Prefer this over
 * {@link listProposalsByStatuses} / {@link listAllProposals} whenever the caller
 * is enumerating for display rather than acting on a single proposal.
 */
export async function listProposalsToleratingUndecodable(
  statuses: readonly ProposalStatus[] = ALL_STATUSES,
): Promise<{ proposals: AnyProposal[]; undecodable: UndecodableProposalRef[] }> {
  const entries = await listProposalsReportingUndecodable(statuses);
  const proposals: AnyProposal[] = [];
  const undecodable: UndecodableProposalRef[] = [];
  for (const entry of entries) {
    if (entry.kind === "undecodable") {
      undecodable.push({
        id: entry.id,
        status: entry.status,
        defect: entry.defect,
        raw_doc_paths: entry.raw_doc_paths,
      });
      continue;
    }
    proposals.push(entry.proposal);
  }
  proposals.sort(compareProposalsNewestFirst);
  undecodable.sort((a, b) => a.id.localeCompare(b.id));
  return { proposals, undecodable };
}

export type ListActiveProposalsOptions = {
  claimScope?: readonly DocPath[];
};

export async function listActiveProposalsByStatuses(
  statuses: readonly ActiveProposalStatus[],
  options?: ListActiveProposalsOptions,
): Promise<ActiveProposal[]> {
  const claimScope = options?.claimScope;
  if (claimScope !== undefined && claimScope.length === 0) {
    return [];
  }

  const proposals: ActiveProposal[] = [];

  for (const currentStatus of statuses) {
    const entries = await readDirentsIfExists(statusDir(currentStatus));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = path.join(statusDir(currentStatus), entry.name, "meta.json");
      if (!(await pathExists(metaPath))) continue;
      if (claimScope !== undefined) {
        const raw = parseJson(await readFile(metaPath, "utf8"));
        const claims = proposalJsonClaimsAnyDoc(raw, claimScope);
        if (claims === null) {
          throw new Error(
            `Cannot determine claimed documents for active proposal meta at ${metaPath}`,
          );
        }
        if (!claims) continue;
        proposals.push(decodeActiveProposal(raw, currentStatus));
        continue;
      }
      proposals.push(await readActiveProposalFile(metaPath, currentStatus));
    }
  }

  proposals.sort(compareProposalsNewestFirst);
  return proposals;
}

export async function listActiveProposals(): Promise<ActiveProposal[]> {
  return listActiveProposalsByStatuses(["draft", "inprogress", "committing"]);
}

function errorDefectMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/**
 * Enumerate proposal metas for triage: decoded entries succeed; decode failures
 * become `undecodable` records instead of throwing. Not for locks/commits.
 */
export async function listProposalsReportingUndecodable(
  statuses: readonly ProposalStatus[],
): Promise<ProposalReportingUndecodableEntry[]> {
  const entries: ProposalReportingUndecodableEntry[] = [];

  for (const currentStatus of statuses) {
    const dirents = await readDirentsIfExists(statusDir(currentStatus));
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const metaPath = path.join(statusDir(currentStatus), dirent.name, "meta.json");
      if (!(await pathExists(metaPath))) continue;

      let raw;
      try {
        raw = parseJson(await readFile(metaPath, "utf8"));
      } catch (error) {
        entries.push({
          kind: "undecodable",
          id: dirent.name,
          status: currentStatus,
          defect: errorDefectMessage(error),
          raw_doc_paths: [],
        });
        continue;
      }

      try {
        entries.push({ kind: "decoded", proposal: decodeProposal(raw, currentStatus) });
      } catch (error) {
        entries.push({
          kind: "undecodable",
          id: proposalJsonIdOrNull(raw) ?? dirent.name,
          status: currentStatus,
          defect: errorDefectMessage(error),
          raw_doc_paths: rawClaimedDocPathsFromProposalJson(raw) ?? [],
        });
      }
    }
  }

  return entries;
}

/**
 * The proposals an admin needs to tend to: decoded entries still carrying a
 * `degraded` marker, plus metas that fail strict decode. Uses
 * {@link listProposalsReportingUndecodable}. Skips `withdrawn`.
 */
export async function listDegradedProposals(): Promise<ListDegradedProposalsResponse> {
  const scannedStatuses = ALL_STATUSES.filter((s) => s !== "withdrawn");
  const entries = await listProposalsReportingUndecodable(scannedStatuses);
  const proposals: AnyProposal[] = [];
  const undecodable: UndecodableProposalRef[] = [];
  for (const entry of entries) {
    if (entry.kind === "undecodable") {
      undecodable.push({
        id: entry.id,
        status: entry.status,
        defect: entry.defect,
        raw_doc_paths: entry.raw_doc_paths,
      });
      continue;
    }
    if (entry.proposal.degraded !== undefined && entry.proposal.degraded.length > 0) {
      proposals.push(entry.proposal);
    }
  }
  return { proposals, undecodable };
}

export async function listDraftProposals(): Promise<ActiveProposal[]> {
  return listActiveProposalsByStatuses(["draft"]);
}

export async function readAgentDraftOwnersForDocument(docPath: DocPath): Promise<WriterIdentity[]> {
  const claimedDocPath = DocPath.parse(docPath);
  const drafts = await listActiveProposalsByStatuses(["draft"], { claimScope: [claimedDocPath] });
  const ownersByWriterId = new Map<string, WriterIdentity>();
  for (const proposal of drafts) {
    if (proposal.writer.type !== "agent") continue;
    if (ownersByWriterId.has(proposal.writer.id)) continue;
    const targetsDocument = proposal.targets.some(
      (target) => target.doc_path === claimedDocPath,
    );
    if (targetsDocument) ownersByWriterId.set(proposal.writer.id, proposal.writer);
  }
  return [...ownersByWriterId.values()];
}

export async function listPendingProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["pending"]);
}

export async function listInProgressProposals(): Promise<ActiveProposal[]> {
  return listActiveProposalsByStatuses(["inprogress"]);
}

export async function listCommittingProposals(): Promise<ActiveProposal[]> {
  return listActiveProposalsByStatuses(["committing"]);
}

export async function listCommittedProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["committed"]);
}

export async function listWithdrawnProposals(): Promise<AnyProposal[]> {
  return listProposalsByStatuses(["withdrawn"]);
}

export async function findDraftProposalByWriter(writerId: string): Promise<AnyProposal | null> {
  const matches: ActiveProposal[] = [];
  const entries = await readDirentsIfExists(statusDir("draft"));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(statusDir("draft"), entry.name, "meta.json");
    if (!(await pathExists(metaPath))) continue;
    const raw = parseJson(await readFile(metaPath, "utf8"));
    if (proposalJsonWriterId(raw) !== writerId) continue;
    matches.push(decodeActiveProposal(raw, "draft"));
  }
  matches.sort(compareProposalsNewestFirst);
  return matches[0] ?? null;
}

export async function countDraftsByWriter(writerId: string): Promise<number> {
  let count = 0;
  const entries = await readDirentsIfExists(statusDir("draft"));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(statusDir("draft"), entry.name, "meta.json");
    if (!(await pathExists(metaPath))) continue;
    const raw = parseJson(await readFile(metaPath, "utf8"));
    if (proposalJsonWriterId(raw) === writerId) count += 1;
  }
  return count;
}

export interface UpdateProposalResult {
  proposal: ActiveProposal;
  contentRoot: string;
}

/**
 * Replace a proposal's `sections` manifest. The manifest is BRAND-GATED: it can
 * only be a `ProposalManifest` produced by the `mutateProposalContent(...)`
 * boundary (or the explicit recovery escape hatch below), never a raw
 * `ProposalSectionClaim[]` hand-built from request parameters (spec 12 §Proposal FSM
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
  sections: ProposalSectionClaim[],
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
  sections: ProposalSectionClaim[],
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
  const current = await readActiveProposalFile(filePath, status);
  const file: ProposalFileBase = {
    ...proposalToFile(current),
    sections: [...manifest.sections],
    targets: [...manifest.targets],
    ...(intent !== undefined ? { intent } : {}),
  };
  const contentRoot = proposalContentRoot(id, status);
  const emptiedDraft = status === "draft" && manifest.sections.length === 0 && manifest.targets.length === 0;
  const backupRoot = `${contentRoot}.empty-${crypto.randomUUID()}`;
  let movedContentAside = false;

  if (emptiedDraft && await pathExists(contentRoot)) {
    await rename(contentRoot, backupRoot);
    movedContentAside = true;
  }

  try {
    if (emptiedDraft) {
      await mkdir(contentRoot, { recursive: true });
    }
    await writeJsonFile(filePath, file, status);
  } catch (error) {
    if (movedContentAside) {
      await rm(contentRoot, { recursive: true, force: true });
      await rename(backupRoot, contentRoot);
    }
    throw error;
  }

  if (movedContentAside) {
    await rm(backupRoot, { recursive: true, force: true });
  }
  // Re-decode for the typed return (also round-trip-validates the written file).
  return { proposal: await readActiveProposalFile(filePath, status), contentRoot };
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

export async function transitionToCommitting(id: ProposalId): Promise<ActiveProposal> {
  const proposal = await readActiveProposal(id);

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

  // A DocSession-owned (live-edit) proposal with ZERO targets is corruption, not a
  // committable operation: a live edit that claimed no section must never reach
  // `committing`. Empty document-level operations (import/restore/tombstone) stay
  // explicitly represented by DOCUMENT targets, so they have a non-empty target set
  // and pass. This is the FSM-boundary backstop for the empty-manifest refusals in
  // {@link updateCurrentProposalSections} / {@link unionCurrentProposalSections}.
  if (isCrdtOwnedProposal(proposal) && proposal.targets.length === 0) {
    throw new InvalidProposalStateError(
      `Cannot transition DocSession-owned proposal ${id} to committing: it has zero targets. ` +
        `A live-edit proposal with no targets is corruption, never an empty document-level op.`,
    );
  }

  // GENERAL empty-targets gate (spec follow-up — commit-boundary target
  // integrity): a proposal with an EMPTY target set locks and audits nothing, so
  // it must never reach `committing` — even when `sections` is non-empty.
  // `targets` is the authoritative lock/audit claim set; a non-empty `sections`
  // content view cannot make an empty target set safe (a section content write
  // whose claim never reached `targets` is exactly the corruption this guards).
  // This is the universal form of the DocSession refusal above and applies to
  // agent / human / transient proposals alike. Zero-section operations are
  // legitimate ONLY when they carry an explicit DOCUMENT target
  // (create/delete/rename/restore/import), which keeps `targets` non-empty. The
  // ONLY exempt path is the startup-recovery entrypoint
  // (`publishCommittingProposalToCanonical`), which does not pass through here,
  // so classified idempotency re-runs are unaffected.
  if (proposal.targets.length === 0) {
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to committing: it has zero targets. ` +
        `\`targets\` is the authoritative lock/audit claim set — an empty target set ` +
        `claims and locks nothing, so it can never be committed, even with ${proposal.sections.length} ` +
        `section(s) present. A zero-section operation must carry an explicit document target.`,
    );
  }

  // SECTION/TARGET CONSISTENCY gate (spec follow-up): every `sections[]` content
  // claim must have an exact matching section target in `targets`. `targets` is
  // the authoritative lock/audit claim set; a section written into the proposal
  // whose claim never reached `targets` is corruption — it would be committed
  // without ever having been locked or audited. This fires BEFORE the lock check,
  // canonical absorb, and git commit. (`targets` MAY carry extra entries beyond
  // `sections` — document targets, and deleted sections whose path-claim is
  // grow-only retained for lock/audit — so the requirement is one-directional:
  // sections ⊆ section-targets, not equality.)
  const sectionTargetKeys = new Set(
    proposal.targets
      .filter((t) => t.kind === "section")
      .map((t) => sectionGlobalKey(t.doc_path, t.heading_path)),
  );
  const unclaimedSections = proposal.sections.filter(
    (s) => !sectionTargetKeys.has(sectionGlobalKey(s.doc_path, s.heading_path)),
  );
  if (unclaimedSections.length > 0) {
    const labels = unclaimedSections
      .map((s) => sectionGlobalKey(s.doc_path, s.heading_path))
      .join(", ");
    throw new InvalidProposalStateError(
      `Cannot transition proposal ${id} to committing: ${unclaimedSections.length} section claim(s) ` +
        `[${labels}] are present in \`sections\` but have no matching section target in \`targets\`. ` +
        `A section that was never claimed as a lock/audit target is corrupt and cannot be committed.`,
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
    // Lock-boundary empty-target refusal (spec follow-up): normal commit lock
    // checks require a NON-EMPTY target set for ALL writer types and proposal
    // origins — agent / human / transient / DocSession alike. An empty lock result
    // must never be treated as proof a proposal is safe to commit. This is
    // belt-and-suspenders with the universal zero-targets refusal above; the ONLY
    // path that legitimately locks-then-commits without a fresh target set is the
    // classified recovery/idempotency re-run, which bypasses this function.
    requireNonEmpty: true,
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
  const proposal = await readActiveProposal(id);
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

  return readProposalFile(proposalPath("committed", id), "committed");
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
  const proposal = await readActiveProposal(id);
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
  return readProposalFile(proposalPath("withdrawn", id), "withdrawn");
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
 * Demote a `pending` transient proposal to `draft` after the agent write policy
 * declined its immediate commit. A blocked Tier 1/2 write is returned to the
 * agent as a durable draft it can retry or withdraw by `proposal_id`; leaving it
 * in `pending/` would make it startup-recovery debris (pending is discarded on
 * restart) despite the tool having reported `status: "draft"`.
 */
export async function demoteTransientProposalToDraft(id: ProposalId): Promise<AnyProposal> {
  const proposal = await readProposal(id);
  if (proposal.status !== "pending") {
    throw new InvalidProposalStateError(
      `Cannot demote proposal ${id} to draft: status is ${proposal.status}, expected pending.`,
    );
  }

  // Pure directory rename — no metadata change needed
  const fromDir = proposalDir("pending", id);
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
// is created directly, keyed on the passed-in proposal-adoption identity (Area B
// owns the adoption identity/actor lane; Area F keys on the id string).
//
// One-active-`inprogress`-proposal-per-DocSession is enforced at create time
// (Invariant 7).

/**
 * Find the single CRDT-owned `inprogress` proposal for a proposal-adoption id,
 * if one has been materialized. Returns null before the session's first live edit.
 */
export async function findInProgressProposalByAdoptionId(
  proposalAdoptionId: ProposalAdoptionId,
): Promise<InProgressProposal | null> {
  const adoptionKey = String(proposalAdoptionId);
  const entries = await readDirentsIfExists(statusDir("inprogress"));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(statusDir("inprogress"), entry.name, "meta.json");
    if (!(await pathExists(metaPath))) continue;
    const raw = parseJson(await readFile(metaPath, "utf8"));
    if (proposalJsonAdoptionId(raw) !== adoptionKey) continue;
    const proposal = decodeActiveProposal(raw, "inprogress");
    return proposal.status === "inprogress" ? proposal : null;
  }
  return null;
}

/**
 * Find the CRDT-owned `inprogress` proposal targeting a given doc path, if any.
 * Convenience lookup for the live-edit boundary; a DocSession owns one document.
 */
export async function findInProgressProposalForDoc(
  docPath: DocPath,
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
  docPath: DocPath,
): Promise<InProgressProposal[]> {
  const inProgress = await listActiveProposalsByStatuses(["inprogress"], {
    claimScope: [DocPath.parse(docPath)],
  });
  return inProgress.filter(
    (proposal): proposal is InProgressProposal =>
      proposal.status === "inprogress"
      && proposal.proposalAdoptionId !== undefined
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
export async function getOrCreateInProgressProposalForAdoptionId(input: {
  proposalAdoptionId: ProposalAdoptionId;
  docPath: DocPath;
  writer: WriterIdentity;
  intent?: string;
  sections?: ProposalSectionClaim[];
}): Promise<CreateProposalResult & { proposal: InProgressProposal }> {
  const existing = await findInProgressProposalByAdoptionId(input.proposalAdoptionId);
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
    proposalAdoptionId: input.proposalAdoptionId,
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
  sections: ProposalSectionClaim[],
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
  // A DocSession-owned (live-edit) proposal must never be persisted with an empty
  // section set once materialization has run: `sections` is grow-only (D6) and a
  // live delete keeps its path claim, so an empty result means a client update
  // materialized nothing — corruption, not a legitimate document-level op. Fail
  // loud rather than saving an empty manifest that later publishes as data loss.
  if (isCrdtOwnedProposal(current) && sections.length === 0) {
    throw new Error(
      `Refusing to persist an empty section manifest on DocSession-owned proposal ${id}: a ` +
        `live-edit proposal with no sections after materialization is corruption.`,
    );
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
  addSections: ProposalSectionClaim[],
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

  const merged: ProposalSectionClaim[] = [];
  const seen = new Set<string>();
  for (const section of [...current.sections, ...addSections]) {
    const key = SectionRef.fromTarget(section).globalKey;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(section);
  }

  // A DocSession-owned (live-edit) proposal must never end up with an empty section
  // set: the manifest is grow-only, so an empty union means an authored edit both
  // started from and added nothing — corruption. Fail loud rather than persisting an
  // empty manifest that later publishes as data loss.
  if (isCrdtOwnedProposal(current) && merged.length === 0) {
    throw new Error(
      `Refusing to persist an empty section manifest on DocSession-owned proposal ${id}: a ` +
        `live-edit proposal with no sections after materialization is corruption.`,
    );
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
