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
 *     sync/join ordering (`joinSession`), replacement invalidation, `docSessionId`,
 *     rekey, observer holder add/remove, pending-replacement-notice.
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
import type {
  WriterIdentity,
  WsServerEvent,
  DocumentReplacementNoticePayload,
  DocSessionId,
} from "../types/shared.js";
import { LiveFragmentStringsStore } from "./live-fragment-strings-store.js";
import {
  EMPTY_BODY,
  buildFragmentContent as buildFragmentContentFn,
  stripHeadingFromFragment,
  type FragmentContent,
} from "../storage/section-formatting.js";
import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  CRDTProposalGenerator,
  type LiveDocumentSource,
  type LiveSectionSnapshot,
} from "./crdt-proposal-generator.js";
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
  /** socketIds of live observer sockets for this user. */
  observerSocketIds: Set<string>;
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
  /** All connected participants (editors + observers) keyed by writerId. */
  holders: Map<string, HolderEntry>;
  /** Last edit timestamp per live fragment key. Read by the quiescence command
   *  in the WS coordinator (MW-1b/MW-2) to decide when a fragment has settled. */
  fragmentLastActivity: Map<string, number>;
  lastActivityAt: number;
  createdAt: number;
  baseHead: string;                        // Git HEAD when session was created
  lastWriterId: string;                    // Last writer who edited
  /** All writers who produced at least one edit during this session;
   *  used to build the git co-author list at commit time. */
  contributors: Map<string, WriterIdentity>;
  /** Explicit identity boundary for this live Y.Doc lifetime. */
  docSessionId: DocSessionId;
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

// ─── Lookup ──────────────────────────────────────────────────────

export function lookupDocSession(docPath: string): DocSession | undefined {
  return sessions.get(docPath);
}

export function getDocSessionId(docPath: string): DocSessionId | null {
  return sessions.get(docPath)?.docSessionId ?? null;
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
function makeLiveDocumentSource(session: DocSession): LiveDocumentSource {
  return {
    async snapshotSections(): Promise<LiveSectionSnapshot[]> {
      const { resolveLiveSectionLayout } = await import("./live-section-layout.js");
      const layout = await resolveLiveSectionLayout(session.docPath, session.generator.getCurrentProposalId());
      const snapshots: LiveSectionSnapshot[] = [];
      for (const entry of layout) {
        const fragment = session.liveFragments.readFragmentString(entry.fragmentKey);
        const body = stripHeadingFromFragment(fragment, entry.level);
        snapshots.push({
          headingPath: [...entry.headingPath],
          heading: entry.heading,
          level: entry.level,
          body: body as unknown as string,
          fragmentKey: entry.fragmentKey,
        });
      }
      return snapshots;
    },
    contributingWriterIds(): Iterable<string> {
      return session.contributors.keys();
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
        observerSocketIds: new Set(),
      });
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  // Slow path: construct the live Y.Doc by reseeding from canonical + any
  // existing `inprogress` proposal for this document (spec 05 §Y.Doc
  // Construction / §Crash Recovery). NO sessions/ overlay, NO raw fragments.
  const creationPromise = (async (): Promise<DocSession> => {
    const session = await constructDocSession(docPath, writerId, baseHead);
    sessions.set(docPath, session);
    return session;
  })();

  sessionPromises.set(docPath, creationPromise);

  const session = await creationPromise;
  if (!identity) {
    throw new Error(`acquireDocSession requires writerIdentity for initial holder "${writerId}" on doc "${docPath}".`);
  }
  session.holders.set(writerId, {
    identity,
    editorSocketIds: new Set(socketId ? [socketId] : []),
    observerSocketIds: new Set(),
  });
  session.lastActivityAt = Date.now();
  session.state = "active";

  return session;
}

async function constructDocSession(
  docPath: string,
  writerId: string,
  baseHead: string,
): Promise<DocSession> {
  const { DocumentSkeletonInternal } = await import("../storage/document-skeleton.js");
  const { listInProgressProposalsForDoc } = await import("../storage/proposal-repository.js");
  const { proposalContentRoot } = await import("../storage/proposal-repository.js");

  const canonicalRoot = getContentRoot();

  // Durable in-flight state, if any, lives in the existing `inprogress` proposal
  // content tree. Source the skeleton + bodies from there when present; else
  // canonical only. (C1) When such a proposal exists we ADOPT it — reusing its
  // `docSessionId` so the generator's lazy `ensureCurrentProposal` lookup
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

  // (C1) Adopt the existing proposal's DocSession identity when present. Fall
  // back to a fresh id only when there is no proposal to adopt, or — defensively
  // — when a legacy proposal is missing its `docSessionId` (in which case the
  // explicit `initialProposalId` below still binds the generator to it).
  const docSessionId = existingInProgress?.docSessionId ?? crypto.randomUUID();

  const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, seedRoot, canonicalRoot);
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

  const session: DocSession = {
    state: "acquiring",
    ydoc,
    liveFragments: liveStrings,
    docPath,
    holders: new Map(),
    fragmentLastActivity: new Map(),
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    baseHead,
    lastWriterId: writerId,
    contributors: new Map(),
    docSessionId,
    // Filled in below once we can reference `session` for the live source.
    generator: null as unknown as CRDTProposalGenerator,
    publishPause: new DocSessionPublishPause(),
    enqueue: null as unknown as DocSession["enqueue"],
  };

  // Ordered command lane: a serial promise chain. Each command runs to completion
  // (or its own await point) before the next observes/mutates session state.
  let lane: Promise<unknown> = Promise.resolve();
  session.enqueue = <T>(command: () => Promise<T> | T): Promise<T> => {
    const result = lane.then(() => command());
    // Keep the lane alive regardless of individual command outcome.
    lane = result.then(() => undefined, () => undefined);
    return result;
  };

  session.generator = new CRDTProposalGenerator({
    docPath,
    docSessionId: session.docSessionId,
    writer: { id: writerId, type: "human", displayName: writerId },
    source: makeLiveDocumentSource(session),
    // (C1) Bind the generator to the adopted proposal explicitly, so first-edit
    // materialization targets it even if the docSessionId keying ever changes
    // (and as the sole binding for a legacy proposal lacking a docSessionId).
    initialProposalId: existingInProgress?.id,
  });

  if (skeleton.areSkeletonRootsEmpty) {
    // Bootstrap an empty BFH fragment so the first client edit has a section.
    const bfhContent = buildFragmentContentFn(EMPTY_BODY, 0, "");
    const bootstrapMap = new Map<string, FragmentContent>();
    bootstrapMap.set(BEFORE_FIRST_HEADING_KEY, bfhContent);
    session.generator.bootstrapEmptyDocument(ydoc, () => {
      liveStrings.replaceFragmentStrings(bootstrapMap);
    });
  } else {
    // Reseed each section's live fragment from the seed root (inprogress proposal
    // content tree if present, else canonical) so reconnects/restart resume the
    // in-flight state.
    const { ProposalShadowContentLayer } = await import("../storage/content-layer.js");
    const seed = new ProposalShadowContentLayer(seedRoot, canonicalRoot);
    const bulkContent = await seed.readAllSections(docPath);
    const contentMap = new Map<string, FragmentContent>();
    skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, headingPath.length === 0);
      const headingKey = SectionRef.headingKey([...headingPath]);
      const bodyContent = bulkContent?.get(headingKey) ?? EMPTY_BODY;
      contentMap.set(fragmentKey, buildFragmentContentFn(bodyContent, level, heading));
    });
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
    if (holder.editorSocketIds.size === 0 && holder.observerSocketIds.size === 0) {
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

  // The Y.Doc stays alive while ≥1 transport is connected (spec 05 §Session
  // Lifecycle). Last-transport-disconnect is the manager's GC trigger; the
  // current `inprogress` proposal carries in-flight live state across the gap so
  // a subsequent reconnect resumes seamlessly. We discard the in-memory Y.Doc
  // when no holders remain (perf/caching policy DD-8: discard).
  if (session.holders.size === 0) {
    discardSession(session);
    return { sessionEnded: true, contributors: [] };
  }

  return { sessionEnded: false, contributors: [] };
}

/** Discard an in-memory live Y.Doc with no remaining holders. Durable in-flight
 *  state remains in the `inprogress` proposal content tree. */
function discardSession(session: DocSession): void {
  if (sessions.get(session.docPath) !== session) return;
  sessions.delete(session.docPath);
  sessionPromises.delete(session.docPath);
  session.state = "ended";
  session.ydoc.destroy();
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
  session.lastWriterId = writerId;
  session.lastActivityAt = now;
  session.contributors.set(writerId, session.holders.get(writerId)?.identity ?? {
    id: writerId, type: "human", displayName: writerId,
  });
}

// ─── Activity ────────────────────────────────────────────────────

export function updateActivity(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  session.lastActivityAt = Date.now();
}

// ─── Join (atomic sync) ──────────────────────────────────────────

/** MSG_SYNC_STEP_1 byte value — must match crdt-ws-frames.ts. */
const MSG_SYNC_STEP_1_BYTE = 0x00;
/** MSG_SYNC_STEP_2 byte value — must match crdt-ws-frames.ts. */
const MSG_SYNC_STEP_2_BYTE = 0x01;

/**
 * Perform the atomic join sequence for a socket connecting to a session:
 *   1. Send SYNC_STEP_2 with the full Y.Doc state so the client receives all
 *      current content immediately (critical for pre-connected observers whose
 *      SYNC_STEP_1 was dropped because no session existed at the time).
 *   2. Send SYNC_STEP_1 (server's state vector) so the client can contribute any
 *      local state the server lacks (reconnecting editors with offline work).
 *
 * `emitPresenceEvent` is retained as a no-op-friendly hook for the coordinator's
 * join ordering; presence replay was removed with the focus protocol.
 */
export function joinSession(
  session: DocSession,
  sendRaw: (msg: Uint8Array) => void,
  _emitPresenceEvent: (event: WsServerEvent) => void,
): void {
  assertState(session, ["active"]);

  const fullUpdate = Y.encodeStateAsUpdate(session.ydoc);
  const syncStep2 = new Uint8Array(1 + fullUpdate.length);
  syncStep2[0] = MSG_SYNC_STEP_2_BYTE;
  syncStep2.set(fullUpdate, 1);
  sendRaw(syncStep2);

  const sv = Y.encodeStateVector(session.ydoc);
  const syncStep1 = new Uint8Array(1 + sv.length);
  syncStep1[0] = MSG_SYNC_STEP_1_BYTE;
  syncStep1.set(sv, 1);
  sendRaw(syncStep1);
}

// ─── Observer holder management ──────────────────────────────────

/** Count the total number of live editor sockets across all holders in a session. */
export function countEditorSockets(session: DocSession): number {
  let count = 0;
  for (const h of session.holders.values()) count += h.editorSocketIds.size;
  return count;
}

export function addObserverHolder(session: DocSession, writerId: string, identity: WriterIdentity, socketId?: string): void {
  const existing = session.holders.get(writerId);
  if (existing) {
    if (socketId) existing.observerSocketIds.add(socketId);
  } else {
    session.holders.set(writerId, {
      identity,
      editorSocketIds: new Set(),
      observerSocketIds: new Set(socketId ? [socketId] : []),
    });
  }
}

export function removeObserverHolder(docPath: string, writerId: string, socketId?: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  const holder = session.holders.get(writerId);
  if (!holder) return;
  if (socketId) holder.observerSocketIds.delete(socketId);
  if (holder.editorSocketIds.size === 0 && holder.observerSocketIds.size === 0) {
    session.holders.delete(writerId);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────

export function destroyAllSessions(): void {
  for (const session of sessions.values()) {
    session.ydoc.destroy();
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
