/**
 * Y.Doc Lifecycle — `YDocLifecycleManager` + per-document `DocSession` actor.
 *
 * One Y.Doc per document. Live editing state lives in the in-memory Y.Doc while
 * the document is mounted; durable in-flight state lives in the DocSession's
 * single `inprogress` proposal content tree (spec 05 §Session Persistence,
 * §Crash Recovery). There is NO `sessions/` mirror, NO raw fragment sidecar, NO
 * idle timeout, and NO session-end-as-commit-trigger.
 *
 * Two collaborating concepts in this file:
 *
 *   - `YDocLifecycleManager` (module-level functions + `sessions` map): live
 *     session lookup, acquire de-dup / in-flight promise, holder/refcount,
 *     replacement invalidation, `docSessionId`, rekey, observer holder
 *     add/remove, pending-replacement-notice.
 *
 *   - `DocSession` actor lane: a single-threaded ordered command stream owning one
 *     live document (spec 10 §DocSession actor ownership). All commands that can
 *     affect the Y.Doc/proposal boundary — inbound Yjs update handling, first
 *     proposal creation, materialization, structural normalization, publish-trigger
 *     evaluation, publish-pause start/end, final materialization + commit, failure
 *     recovery, restore/admin preflight — are serialized through `session.enqueue`.
 *     The actor hosts the `CRDTProposalGenerator` and `DocSessionPublishPause`.
 *
 * Construction (spec 05 §Y.Doc Construction): on acquire with no in-memory
 * session, the Y.Doc is reseeded from canonical and, if present, the DocSession's
 * existing `inprogress` proposal content tree — never from `sessions/` or raw
 * fragments. Empty documents are bootstrapped with a synthetic before-first-heading
 * fragment.
 */

import * as Y from "yjs";
import { getContentRoot } from "../storage/data-root.js";
import {
  type WriterIdentity,
  type DocumentReplacementNoticePayload,
  DocSessionId,
  ProposalAdoptionId,
} from "../types/shared.js";
import { LiveFragmentStringsStore } from "./live-fragment-strings-store.js";
import {
  EMPTY_BODY,
  buildFragmentContent as buildFragmentContentFn,
  stripHeadingFromFragment,
  type FragmentContent,
} from "../storage/section-formatting.js";
import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import {
  CRDTProposalGenerator,
  type LiveDocumentSource,
  type LiveSectionSnapshot,
  type LiveSectionsSnapshotResult,
  type AwaitingStructuralReconciliationSection,
} from "./crdt-proposal-generator.js";
import { classifyStructuralChange } from "./structural-change.js";
import { DocSessionPublishPause } from "./docsession-publish-pause.js";

// ─── Session state machine ───────────────────────────────────────

export type SessionState = "acquiring" | "active" | "ended";

function assertState(session: DocSession, expected: SessionState[]): void {
  if (!expected.includes(session.state)) {
    throw new Error(
      `DocSession state assertion failed for "${session.docPath}": ` +
      `expected [${expected.join(" | ")}], got "${session.state}"`,
    );
  }
}

// ─── Holder types ────────────────────────────────────────────────

export interface HolderEntry {
  identity: WriterIdentity;
  /** socketIds of live editor sockets for this user. */
  editorSocketIds: Set<string>;
}

// ─── DocSession interface + actor lane ───────────────────────────

export interface DocSession {
  /** Explicit lifecycle state. Drives entry guards and transition assertions. */
  state: SessionState;
  /** The Y.Doc instance backing this session's CRDT state. */
  ydoc: Y.Doc;
  /** Thin Y.Doc fragment adapter: live fragment string reads/writes. */
  liveFragments: LiveFragmentStringsStore;
  docPath: string;
  /**
   * EDITOR session holders only, keyed by writerId. Observers never become
   * holders (spec 05 §Observer CRDT Channel: "Observer connections do not call
   * `acquireDocSession` — they never become session holders"). The Y.Doc discard
   * refcount is driven solely by this map, so a lingering observer can no longer
   * pin a Y.Doc after the last editor leaves.
   */
  holders: Map<string, HolderEntry>;
  /**
   * Live observer socketIds for this document, tracked SEPARATELY from `holders`
   * and deliberately NOT consulted by the Y.Doc-discard test in
   * `releaseDocSession`. Observer presence has no effect on Y.Doc retention or
   * commit cadence (spec 05 §Observer CRDT Channel › Session Lifecycle); this set
   * exists so the coordinator can notify + close observers with 4021 when the last
   * editor leaves, and for lifecycle assertions.
   */
  observerSocketIds: Set<string>;
  /** Last edit timestamp per live fragment key. Read by the quiescence command
   *  in the WS coordinator (MW-1b/MW-2) to decide when a fragment has settled. */
  fragmentLastActivity: Map<string, number>;
  dirtyFragmentKeys: Set<string>;
  /**
   * Fragment keys that a quiescence structural normalization REMOVED this session
   * (heading-deletion merge, empty-BFH dissolve, no-predecessor→BFH), mapped to
   * their removed heading path. Yjs cannot delete the top-level XmlFragment from
   * `ydoc.share`, so a still-bound client can echo a late ("ghost") update into
   * the emptied slot AFTER the section left the layout. The acceptance gate uses
   * this tombstone set to treat such a late write as an EXPECTED delete-under-you
   * (revert + re-emit `section:gone` to force the client off) rather than the
   * hard "no section identity" corruption fatal, which stays for genuinely
   * unknown keys. Keys are opaque and never reused, so entries are never removed.
   */
  removedFragmentTombstones: Map<string, string[]>;
  lastActivityAt: number;
  createdAt: number;
  baseHead: string;                        // Git HEAD when session was created
  lastWriterId: string;                    // Last writer who edited
  /** All writers who produced at least one edit during this session;
   *  used to build the git co-author list at commit time. */
  contributors: Map<string, WriterIdentity>;
  proposalAdoptionId: ProposalAdoptionId;
  liveYDocId: DocSessionId;
  /** The boundary component owning live↔canonical proposal materialization. */
  generator: CRDTProposalGenerator;
  /** Per-DocSession publish-pause FSM (never global). */
  publishPause: DocSessionPublishPause;
  /** Ordered command lane — every Y.Doc/proposal-boundary op runs through this. */
  enqueue: <T>(command: () => Promise<T> | T) => Promise<T>;
}

// ─── Module state ────────────────────────────────────────────────

/** Resolved sessions — populated once the in-flight creation promise settles. */
const sessions = new Map<string, DocSession>();

/**
 * In-flight (and settled) creation promises — keyed by docPath. Stored before any
 * async yield in acquireDocSession to eliminate the TOCTOU race: a concurrent
 * caller for the same docPath awaits the same promise instead of spawning a
 * duplicate construction.
 */
const sessionPromises = new Map<string, Promise<DocSession>>();

// ─── Pending replacement notices ─────────────────────────────────

interface PendingReplacementNotice {
  message: string;
  expiresAt: number;
}

const pendingReplacementNotices = new Map<string, PendingReplacementNotice>();
const REPLACEMENT_NOTICE_TTL_MS = 5 * 60 * 1000;

let _broadcastSessionReplacementInvalidation: ((docPath: string) => void) | null = null;

export function setBroadcastSessionReplacementInvalidation(cb: (docPath: string) => void): void {
  _broadcastSessionReplacementInvalidation = cb;
}

let _broadcastAdminRebuildInvalidation: ((docPath: string) => void) | null = null;

export function setBroadcastAdminRebuildInvalidation(cb: (docPath: string) => void): void {
  _broadcastAdminRebuildInvalidation = cb;
}

// ─── Lookup ──────────────────────────────────────────────────────

export function lookupDocSession(docPath: string): DocSession | undefined {
  return sessions.get(docPath);
}

export function getDocSessionId(docPath: string): DocSessionId | null {
  return sessions.get(docPath)?.liveYDocId ?? null;
}

export function getAllSessions(): Map<string, DocSession> {
  return sessions;
}

/**
 * Re-key a DocSession from oldPath to newPath. Synchronous — must complete before
 * any async I/O yields.
 */
export function rekeyDocSession(oldPath: string, newPath: string): void {
  const session = sessions.get(oldPath);
  if (!session) return;
  sessions.delete(oldPath);
  session.docPath = newPath;
  sessions.set(newPath, session);
  const promise = sessionPromises.get(oldPath);
  if (promise) {
    sessionPromises.delete(oldPath);
    sessionPromises.set(newPath, promise);
  }
}

export function getSessionsForWriter(writerId: string): DocSession[] {
  const result: DocSession[] = [];
  for (const session of sessions.values()) {
    if (session.holders.has(writerId)) {
      result.push(session);
    }
  }
  return result;
}

// ─── Live document source (feeds the generator from the live Y.Doc) ──

/**
 * Build a LiveDocumentSource bound to one DocSession's live Y.Doc + fragment
 * adapter. Section identity is resolved from the current `inprogress` proposal
 * skeleton when present, else canonical; the body is read live from the Y.Doc.
 */
/**
 * Explicit dependencies the live document source needs. Passed instead of the
 * whole `DocSession` so the source can be built BEFORE the (circular) generator
 * exists: `getCurrentProposalId` is a lazy accessor that reads the generator
 * once it has been assigned, and `liveFragments` / `contributors` are the same
 * references the final `DocSession` holds (so mutations stay visible).
 */
interface LiveDocumentSourceDeps {
  docPath: string;
  liveFragments: LiveFragmentStringsStore;
  contributors: Map<string, WriterIdentity>;
  getCurrentProposalId: () => ReturnType<CRDTProposalGenerator["getCurrentProposalId"]>;
}

function makeLiveDocumentSource(deps: LiveDocumentSourceDeps): LiveDocumentSource {
  return {
    async snapshotSections(): Promise<LiveSectionsSnapshotResult> {
      const { resolveLiveSectionLayout } = await import("./live-section-layout.js");
      const layout = await resolveLiveSectionLayout(deps.docPath, deps.getCurrentProposalId());
      const sections: LiveSectionSnapshot[] = [];
      const awaitingStructuralReconciliation: AwaitingStructuralReconciliationSection[] = [];
      for (const entry of layout) {
        const fragment = deps.liveFragments.readFragmentString(entry.fragmentKey);
        if (entry.headingPath.length === 0) {
          sections.push({
            headingPath: [...entry.headingPath],
            heading: entry.heading,
            level: entry.level,
            body: stripHeadingFromFragment(fragment, 0),
            fragmentKey: entry.fragmentKey,
          });
          continue;
        }
        const change = classifyStructuralChange(fragment, {
          headingPath: entry.headingPath,
          heading: entry.heading,
          level: entry.level,
        });
        if (change.kind !== "clean") {
          awaitingStructuralReconciliation.push({
            fragmentKey: entry.fragmentKey,
            headingPath: [...entry.headingPath],
            heading: entry.heading,
            level: entry.level,
          });
          continue;
        }
        const body = stripHeadingFromFragment(fragment, entry.level);
        sections.push({
          headingPath: [...entry.headingPath],
          heading: entry.heading,
          level: entry.level,
          body,
          fragmentKey: entry.fragmentKey,
        });
      }
      return { sections, awaitingStructuralReconciliation };
    },
    contributingWriterIds(): Iterable<string> {
      return deps.contributors.keys();
    },
  };
}

// ─── Session Acquire / Release ───────────────────────────────────

export async function acquireDocSession(
  docPath: string,
  writerId: string,
  baseHead: string,
  writerIdentity?: WriterIdentity,
  socketId?: string,
): Promise<DocSession> {
  const identity = writerIdentity;

  // Fast path: session already exists (resolved) or creation is in-flight.
  const existingPromise = sessionPromises.get(docPath);
  if (existingPromise) {
    const session = await existingPromise;
    const existing = session.holders.get(writerId);
    if (existing) {
      if (socketId) existing.editorSocketIds.add(socketId);
    } else {
      if (!identity) {
        throw new Error(`acquireDocSession requires writerIdentity for new holder "${writerId}" on doc "${docPath}".`);
      }
      session.holders.set(writerId, {
        identity,
        editorSocketIds: new Set(socketId ? [socketId] : []),
      });
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  // Slow path: construct the live Y.Doc by reseeding from canonical + any
  // existing `inprogress` proposal for this document (spec 05 §Y.Doc
  // Construction / §Crash Recovery). NO sessions/ overlay, NO raw fragments.
  if (!identity) {
    throw new Error(`acquireDocSession requires writerIdentity for initial holder "${writerId}" on doc "${docPath}".`);
  }
  const initialIdentity = identity;
  const creationPromise = (async (): Promise<DocSession> => {
    const session = await constructDocSession(docPath, writerId, baseHead, initialIdentity);
    sessions.set(docPath, session);
    return session;
  })();

  sessionPromises.set(docPath, creationPromise);

  const session = await creationPromise;
  session.holders.set(writerId, {
    identity: initialIdentity,
    editorSocketIds: new Set(socketId ? [socketId] : []),
  });
  session.lastActivityAt = Date.now();
  session.state = "active";

  return session;
}

async function constructDocSession(
  docPath: string,
  writerId: string,
  baseHead: string,
  writerIdentity: WriterIdentity,
): Promise<DocSession> {
  const { DocumentSkeletonInternal } = await import("../storage/document-skeleton.js");
  const { listInProgressProposalsForDoc } = await import("../storage/proposal-repository.js");
  const { proposalContentRoot, loadDeletedSectionFiles } = await import("../storage/proposal-repository.js");

  const canonicalRoot = getContentRoot();

  // Durable in-flight state, if any, lives in the existing `inprogress` proposal
  // content tree. Source the skeleton + bodies from there when present; else
  // canonical only. (C1) When such a proposal exists we ADOPT it — reusing its
  // `proposalAdoptionId` so the generator's lazy `ensureCurrentProposal` lookup
  // resolves to the SAME proposal rather than forking a second one on the first
  // edit after restart/remount (spec 10 §One active proposal per DocSession).
  const inProgressMatches = await listInProgressProposalsForDoc(docPath);
  if (inProgressMatches.length > 1) {
    // Invariant 7 violated on disk (should be impossible post-C1). Refuse rather
    // than silently pick the first match and orphan the rest.
    console.error(
      `[ydoc-lifecycle] refusing to reconstruct DocSession for "${docPath}": `
      + `found ${inProgressMatches.length} CRDT-owned inprogress proposals `
      + `(${inProgressMatches.map((p) => p.id).join(", ")}); expected at most one.`,
    );
    throw new Error(
      `Cannot reconstruct DocSession for "${docPath}": ${inProgressMatches.length} `
      + `inprogress proposals target it (one-active-proposal-per-DocSession violated).`,
    );
  }
  const existingInProgress = inProgressMatches[0] ?? null;
  const seedRoot = existingInProgress
    ? proposalContentRoot(existingInProgress.id, "inprogress")
    : canonicalRoot;

  // (C1) Adopt the existing proposal's adoption identity when present. Fall
  // back to a fresh id only when there is no proposal to adopt, or — defensively
  // — when a legacy proposal is missing its `proposalAdoptionId` (in which case
  // the explicit `initialProposalId` below still binds the generator to it).
  const proposalAdoptionId = existingInProgress?.proposalAdoptionId
    ?? ProposalAdoptionId.create();
  const liveYDocId = DocSessionId.create();

  // Manifest-overlay (U3 / D5): seed via the SAME merge as every other proposal
  // read — current canonical overlaid by the adopted proposal's structural changes.
  // A body-only in-flight proposal has no overlay skeleton, so reconstruct inherits
  // CURRENT canonical structure (including sections committed after the proposal
  // opened — the data-loss fix); a section the live session deleted is dropped by
  // its canonical section-file id (identity-based delete detection). There is NO
  // live wholesale opt-out. With no adopted proposal the seed root IS canonical, so
  // `fromDisk` takes the canonical-only path (deleted ids irrelevant, left undefined).
  const deletedSectionFiles = existingInProgress
    ? await loadDeletedSectionFiles(existingInProgress.id, docPath)
    : undefined;
  const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, seedRoot, canonicalRoot, deletedSectionFiles);
  const ydoc = new Y.Doc();

  const orderedKeys: string[] = [];
  skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, headingPath.length === 0);
    if (!orderedKeys.includes(fragmentKey)) orderedKeys.push(fragmentKey);
  });

  // Empty-doc bootstrap: seed the synthetic BFH key so the first edit lands on a
  // known fragment (spec 05 §Y.Doc Construction Case 3, kept BFH bootstrap).
  if (skeleton.areSkeletonRootsEmpty) {
    orderedKeys.push(BEFORE_FIRST_HEADING_KEY);
  }

  const liveStrings = new LiveFragmentStringsStore(ydoc, orderedKeys, docPath);

  // Build the non-circular pieces first, then construct the final DocSession once
  // every field has a real value — no forged `null as unknown as ...` placeholders.

  // Ordered command lane: a serial promise chain. Each command runs to completion
  // (or its own await point) before the next observes/mutates session state.
  let lane: Promise<unknown> = Promise.resolve();
  const enqueue: DocSession["enqueue"] = <T>(command: () => Promise<T> | T): Promise<T> => {
    const result = lane.then(() => command());
    // Keep the lane alive regardless of individual command outcome.
    lane = result.then(() => undefined, () => undefined);
    return result;
  };

  // Shared contributor map: the live source and the final DocSession reference the
  // SAME map so edit-attribution writes stay visible to snapshot reads.
  const contributors = new Map<string, WriterIdentity>();

  const generator: CRDTProposalGenerator = new CRDTProposalGenerator({
    docPath,
    proposalAdoptionId,
    writer: writerIdentity,
    // The source reads `getCurrentProposalId` lazily; `generator` is assigned by
    // the time any snapshot runs, so referencing it here is safe (it is never
    // invoked during construction).
    source: makeLiveDocumentSource({
      docPath,
      liveFragments: liveStrings,
      contributors,
      getCurrentProposalId: () => generator.getCurrentProposalId(),
    }),
    // (C1) Bind the generator to the adopted proposal explicitly, so first-edit
    // materialization targets it even if the adoption-id keying ever changes
    // (and as the sole binding for a legacy proposal lacking a `proposalAdoptionId`).
    initialProposalId: existingInProgress?.id,
  });

  const session: DocSession = {
    state: "acquiring",
    ydoc,
    liveFragments: liveStrings,
    docPath,
    holders: new Map(),
    observerSocketIds: new Set(),
    fragmentLastActivity: new Map(),
    dirtyFragmentKeys: new Set(),
    removedFragmentTombstones: new Map(),
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    baseHead,
    lastWriterId: writerId,
    contributors,
    proposalAdoptionId,
    liveYDocId,
    generator,
    publishPause: new DocSessionPublishPause(),
    enqueue,
  };

  if (skeleton.areSkeletonRootsEmpty) {
    // Bootstrap an empty BFH fragment so the first client edit has a section.
    const bfhContent = buildFragmentContentFn(EMPTY_BODY, 0, "");
    const bootstrapMap = new Map<string, FragmentContent>();
    bootstrapMap.set(BEFORE_FIRST_HEADING_KEY, bfhContent);
    session.generator.bootstrapEmptyDocument(ydoc, () => {
      liveStrings.replaceFragmentStrings(bootstrapMap);
    });
  } else {
    // Reseed each section's live fragment from the current `inprogress` proposal
    // (if present, else canonical) so reconnects/restart resume the in-flight
    // state. The seed/rebuild helper resolves layout + bodies through the
    // proposal-bound read APIs — it is not handed a `(primaryRoot, canonicalRoot)`
    // pair.
    const { buildLiveSeedContentMap } = await import("./live-section-layout.js");
    const contentMap = await buildLiveSeedContentMap(docPath, existingInProgress?.id ?? null);
    liveStrings.replaceFragmentStrings(contentMap);
  }

  return session;
}

export interface ReleaseResult {
  sessionEnded: boolean;
  contributors: WriterIdentity[];
}

/**
 * Synchronous lifecycle boundary: remove one editor-holder attachment. No async
 * I/O is allowed in this method.
 */
export function removeEditorHolder(
  docPath: string,
  writerId: string,
  socketId?: string,
): { session: DocSession | null; lastEditorDetached: boolean } {
  const session = sessions.get(docPath);
  if (!session) return { session: null, lastEditorDetached: false };

  const holder = session.holders.get(writerId);
  if (holder) {
    if (socketId) holder.editorSocketIds.delete(socketId);
    if (holder.editorSocketIds.size === 0) {
      session.holders.delete(writerId);
    }
  }

  const lastEditorDetached = countEditorSockets(session) === 0;
  return { session, lastEditorDetached };
}

export async function releaseDocSession(
  docPath: string,
  writerId: string,
  socketId?: string,
): Promise<ReleaseResult> {
  const removal = removeEditorHolder(docPath, writerId, socketId);
  const session = removal.session;
  if (!session) return { sessionEnded: false, contributors: [] };

  // The Y.Doc is discarded when the last EDITOR leaves (spec 05 §Observer CRDT
  // Channel: the trigger is "no live editor-backed CRDT surface for that
  // docPath"). Since observers are no longer holders, `holders.size === 0` is an
  // editor-only refcount by construction — a lingering observer no longer pins
  // the Y.Doc. The current `inprogress` proposal carries in-flight live state
  // across the gap so a subsequent reconnect resumes seamlessly (DD-8: discard).
  // The coordinator notifies + closes any remaining observers with 4021 BEFORE it
  // calls this, so observers fall back to canonical REST reads losing nothing.
  if (session.holders.size === 0) {
    discardSession(session);
    return { sessionEnded: true, contributors: [] };
  }

  return { sessionEnded: false, contributors: [] };
}

/**
 * Listeners invoked with a docPath whenever its live session is torn down, on
 * EVERY discard route (last-editor-leave, replacement/rebuild, shutdown). The WS
 * coordinator registers `cancelQuiescenceTimer` here so a session's autonomous-
 * publish timer is cancelled the moment the session that armed it dies — no route
 * can leave a coordinator timer dangling against a later session for the doc.
 * Kept as an upward hook so the lower lifecycle layer stays free of any coordinator
 * (timer) import.
 */
const sessionDiscardListeners = new Set<(docPath: string) => void>();
export function onSessionDiscard(listener: (docPath: string) => void): void {
  sessionDiscardListeners.add(listener);
}
function notifySessionDiscarded(docPath: string): void {
  for (const listener of sessionDiscardListeners) listener(docPath);
}

/** Discard an in-memory live Y.Doc with no remaining holders. Durable in-flight
 *  state remains in the `inprogress` proposal content tree. */
function discardSession(session: DocSession): void {
  if (sessions.get(session.docPath) !== session) return;
  sessions.delete(session.docPath);
  sessionPromises.delete(session.docPath);
  session.state = "ended";
  session.ydoc.destroy();
  notifySessionDiscarded(session.docPath);
}

// ─── Per-section activity attribution ────────────────────────────

/**
 * Record that `writerId` touched `fragmentKey` in this session. Updates the
 * per-fragment last-activity timestamp (consumed by the WS coordinator's
 * quiescence command) and the session-level last-writer / contributor tracking.
 */
export function noteFragmentActivity(
  session: DocSession,
  writerId: string,
  fragmentKey: string,
): void {
  const now = Date.now();
  session.fragmentLastActivity.set(fragmentKey, now);
  session.dirtyFragmentKeys.add(fragmentKey);
  session.lastWriterId = writerId;
  session.lastActivityAt = now;

  const holderIdentity = session.holders.get(writerId)?.identity;
  const existingContributor = session.contributors.get(writerId);
  const generatorWriter = session.generator.getWriterIdentity();
  const generatorIdentity = generatorWriter.id === writerId ? generatorWriter : undefined;
  const resolved =
    holderIdentity ??
    existingContributor ??
    generatorIdentity ??
    { id: writerId, type: "human" as const, displayName: writerId };

  // Never replace an existing real display name with a forged placeholder.
  const isPlaceholder = (w: WriterIdentity) => w.displayName === writerId;
  if (existingContributor && isPlaceholder(resolved) && !isPlaceholder(existingContributor)) {
    return;
  }
  session.contributors.set(writerId, resolved);
}

// ─── Activity ────────────────────────────────────────────────────

export function updateActivity(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  session.lastActivityAt = Date.now();
}

// ─── Observer socket tracking (NOT holders) ──────────────────────

/** Count the total number of live editor sockets across all holders in a session. */
export function countEditorSockets(session: DocSession): number {
  let count = 0;
  for (const h of session.holders.values()) count += h.editorSocketIds.size;
  return count;
}

/**
 * Track an observer socket on the session WITHOUT making it a holder (spec 05
 * §Observer CRDT Channel: observers never become session holders). The set is
 * separate from `holders` and is not consulted by the Y.Doc-discard test, so an
 * observer cannot pin a Y.Doc or affect the publish-trigger refcount.
 */
export function addObserverSocket(session: DocSession, socketId: string): void {
  session.observerSocketIds.add(socketId);
}

/**
 * Drop an observer socket. Lifecycle-neutral by contract: it does NOT call
 * `releaseDocSession` and has no effect on Y.Doc retention or commit cadence
 * (spec 05 §Observer CRDT Channel: "Observer disconnection has no effect on
 * Y.Doc retention policy or commit cadence").
 */
export function removeObserverSocket(docPath: string, socketId: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  session.observerSocketIds.delete(socketId);
}

// ─── Cleanup ─────────────────────────────────────────────────────

export function destroyAllSessions(): void {
  for (const session of sessions.values()) {
    session.ydoc.destroy();
    session.state = "ended";
    // Fire the same discard hook every other teardown route uses, so shutdown /
    // test-reset also cancels any coordinator-owned quiescence timer.
    notifySessionDiscarded(session.docPath);
  }
  sessions.clear();
  sessionPromises.clear();
}

/**
 * Destroy all active sessions. Used at shutdown. Durable in-flight state remains
 * in `inprogress` proposal content trees; there is no flush step.
 */
export async function flushAndDestroyAll(): Promise<void> {
  destroyAllSessions();
}

// ─── Session replacement invalidation ────────────────────────────

/**
 * Return the pending replacement notice for reconnecting clients on docPath.
 * Returns null if no notice exists or if it has expired. Does NOT consume it.
 */
export function getPendingReplacementNotice(
  docPath: string,
): DocumentReplacementNoticePayload | null {
  const entry = pendingReplacementNotices.get(docPath);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingReplacementNotices.delete(docPath);
    return null;
  }
  return { message: entry.message };
}

/**
 * Invalidate the live Y.Doc for a document replaced by restore or forced
 * canonical replacement (spec 05 §Restore: Pre-emptive Session Handoff step 5).
 *
 * Precondition: live state has already been published-or-aborted via the
 * DocSession actor at the route/store boundary (publish-trigger rule 1: forced
 * canonical op). This function does the disruptive part only:
 *   1. Store any pending reconnect notice before closing sockets.
 *   2. Broadcast close code 4022 to all connected sockets (via callback).
 *   3. Close + discard the in-memory live Y.Doc.
 */
export async function invalidateSessionForReplacement(
  docPath: string,
  notice: DocumentReplacementNoticePayload | null,
): Promise<void> {
  if (notice) {
    pendingReplacementNotices.set(docPath, {
      message: notice.message,
      expiresAt: Date.now() + REPLACEMENT_NOTICE_TTL_MS,
    });
  } else {
    pendingReplacementNotices.delete(docPath);
  }

  if (_broadcastSessionReplacementInvalidation) {
    _broadcastSessionReplacementInvalidation(docPath);
  }

  const session = sessions.get(docPath);
  if (session) {
    assertState(session, ["active", "acquiring"]);
    session.publishPause.end();
    session.state = "ended";
    session.ydoc.destroy();
    sessions.delete(docPath);
    sessionPromises.delete(docPath);
  }
}

/**
 * Admin force-rebuild (DD-4) lifecycle side-effects (spec 01 §3 YDocLifecycleManager;
 * spec 05 §Session Lifecycle / §Close codes). A rare, deliberately disruptive
 * primitive: an admin has committed to canonical bypassing all blocking (HI
 * evaluation, `inprogress` lock, freeze), and the live Y.Doc must be torn down so
 * connected clients reseed from the new canonical content.
 *
 * Precondition: the admin's canonical mutation has already landed at the
 * route/store boundary. This function does the disruptive part only:
 *   1. Close all CRDT sockets to the document with the admin-rebuild close code
 *      4024 (via callback) so clients reconnect immediately and reseed.
 *   2. Destroy + discard the in-memory live Y.Doc.
 *
 * No salvage of in-flight CRDT content is attempted: any live work in the
 * destroyed Y.Doc that overlaps the rebuilt sections is discarded BY DESIGN
 * (spec 01 §3: "the admin operation is by design destructive of live work that
 * overlaps the rebuilt sections"). This is distinct from restore (4022): there is
 * no reconnect notice and no publish-or-abort handoff — the admin operation has
 * already bypassed live editing.
 */
export async function invalidateSessionForAdminRebuild(docPath: string): Promise<void> {
  if (_broadcastAdminRebuildInvalidation) {
    _broadcastAdminRebuildInvalidation(docPath);
  }

  const session = sessions.get(docPath);
  if (session) {
    assertState(session, ["active", "acquiring"]);
    session.publishPause.end();
    session.state = "ended";
    session.ydoc.destroy();
    sessions.delete(docPath);
    sessionPromises.delete(docPath);
  }
}
