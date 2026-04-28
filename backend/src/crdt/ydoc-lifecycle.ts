/**
 * Y.Doc Lifecycle — Session acquire/release/destroy, holders, timers.
 *
 * One Y.Doc per document. Session lifecycle:
 *   - Created when first writer connects to a document
 *   - Destroyed when last holder disconnects (after flush to disk)
 *   - Survives mid-session commits (baseHead updated)
 *   - Reconstructed from canonical + sessions/sections/ overlay on reconnect
 */

import path from "node:path";
import * as Y from "yjs";
import { getContentRoot, getSessionSectionsContentRoot } from "../storage/data-root.js";
import type {
  WriterIdentity,
  WsServerEvent,
  DocumentReplacementNoticePayload,
  DocSessionId,
} from "../types/shared.js";
import { LiveFragmentStringsStore, SERVER_INJECTION_ORIGIN } from "./live-fragment-strings-store.js";
import { RawFragmentRecoveryBuffer } from "../storage/raw-fragment-recovery-buffer.js";
import { StagedSectionsStore, type AcceptResult, type SettleResult } from "../storage/staged-sections-store.js";
import { PresenceManager } from "./presence-manager.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  EMPTY_BODY,
  buildFragmentContent as buildFragmentContentFn,
  type FragmentContent,
} from "../storage/section-formatting.js";
import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import { SessionQuiescencePolicy } from "./session-quiescence-policy.js";

export { SERVER_INJECTION_ORIGIN };

// ─── Session state machine ───────────────────────────────────────

export type SessionState = "acquiring" | "active" | "flushing" | "ended";

/**
 * Assert that a session is in one of the expected states.
 * Throws if the assertion fails — errors surface in logs rather than failing silently.
 */
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

// ─── DocSession interface ────────────────────────────────────────

export interface DocSession {
  /** Explicit lifecycle state. Drives entry guards and transition assertions. */
  state: SessionState;
  /** The Y.Doc instance backing this session's CRDT state. */
  ydoc: Y.Doc;
  /** Backend-boundary-1 store: Y.Doc ↔ live fragment string reads/writes. */
  liveFragments: LiveFragmentStringsStore;
  recoveryBuffer: RawFragmentRecoveryBuffer;
  stagedSections: StagedSectionsStore;
  docPath: string;
  /** All connected participants (editors + observers) keyed by writerId. */
  holders: Map<string, HolderEntry>;
  /** Server-authoritative section focus. Set from SECTION_FOCUS binary messages in crdt-sync.ts. */
  presenceManager: PresenceManager;
  /** Tracks the runtime fragment refs each writer has dirtied in this live
   *  session. Complementary to lastEditPulse — this records *what* changed,
   *  while lastEditPulse records *when* the user last actively typed. */
  perUserDirty: Map<string, Set<string>>;  // writerId → set of fragment keys they dirtied
  fragmentLastActivity: Map<string, number>;  // fragmentKey → timestamp of last edit
  fragmentFirstActivity: Map<string, number>; // fragmentKey → timestamp of first edit in this session
  /** Timestamp of last WebSocket activity of any kind (sync, awareness, pulse).
   *  Used only as a fallback for auto-commit timing when no pulses have been received.
   *  For edit-intent decisions (idle timeout, hard blocks, human-involvement scoring), use lastEditPulse. */
  lastActivityAt: number;
  /** Per-writer timestamp of last ACTIVITY_PULSE (intentional human editing).
   *  This is the authoritative signal for "user is actively typing" — drives idle timeout,
   *  hard-block decisions, graduated human-involvement scoring, and semantic commit boundaries.
   *  Complementary to perUserDirty: this records *when*, perUserDirty records *what*. */
  lastEditPulse: Map<string, number>;
  idleTimeoutTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  baseHead: string;                        // Git HEAD when session was created (updated on commit)
  lastWriterId: string;                    // Last writer who edited
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** All writers who sent at least one MSG_ACTIVITY_PULSE during this session.
   *  Accumulated by the coordinator; used to build the git co-author list at commit time. */
  contributors: Map<string, WriterIdentity>;
  /** Explicit identity boundary for this live Y.Doc lifetime. */
  docSessionId: DocSessionId;
  quiescencePolicy: SessionQuiescencePolicy;
}

// ─── Module state ────────────────────────────────────────────────

/** Resolved sessions — populated once the in-flight creation promise settles. */
const sessions = new Map<string, DocSession>();

/**
 * In-flight (and settled) creation promises — keyed by docPath.
 * Stored immediately before any async yield in acquireDocSession to eliminate
 * the TOCTOU race: a second concurrent caller for the same docPath will find
 * the promise here and await it, sharing the same DocSession rather than
 * spawning a duplicate fromDisk() call that would orphan the first session's
 * holders, Y.Doc listeners, and idle timers.
 *
 * Both maps are always kept in sync:
 *   - sessionPromises entry created  → sessions entry created when promise settles
 *   - sessionPromises entry deleted  → sessions entry deleted simultaneously
 */
const sessionPromises = new Map<string, Promise<DocSession>>();

const IDLE_TIMEOUT_MS = 60_000;
const FLUSH_DEBOUNCE_MS = 4_000;

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
 * Re-key a DocSession from oldPath to newPath. Synchronous — must complete
 * before any async I/O yields so flush timers use the new path.
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
  // Concurrent callers for the same docPath share the single in-flight promise,
  // eliminating the TOCTOU race that would spawn duplicate fromDisk() calls.
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
    resetIdleTimeout(session);
    return session;
  }

  // Slow path: explicit store construction sequence.
  // Store the promise BEFORE the first await so any concurrent caller hits
  // the fast path above instead of spawning a second construction.
  //
  // Sequence:
  //   1. Load mutable skeleton from disk (overlay → canonical resolution)
  //   2. Choose per-section startup content from runtime sources
  //      (live-store mediated raw fragments are freshest; fall back to overlay/canonical body)
  //   3. Construct LiveFragmentStringsStore + RawFragmentRecoveryBuffer + StagedSectionsStore
  //   4. Bulk-apply chosen content via replaceFragmentStrings
  //   5. Normalize any sections that were sourced from raw fragments
  //
  // Crash recovery (orphaned bodies, Recovered edits salvage) is INTENTIONALLY
  // absent here. Per item 343: real crash recovery only runs on server start
  // via `backend/src/storage/crash-recovery.ts`. Per-session acquisition must
  // not append recovery sections, surface orphan bodies, or perform any other
  // crash-recovery behavior on reconnect.
  const creationPromise = (async (): Promise<DocSession> => {
    // Lazy-imported to avoid circular dependencies
    // (content-layer ↔ document-skeleton).
    const { DocumentSkeletonInternal } = await import("../storage/document-skeleton.js");
    const { OverlayContentLayer } = await import("../storage/content-layer.js");
    const { fragmentFromDisk } = await import("../storage/section-formatting.js");

    const canonicalRoot = getContentRoot();
    const overlayRoot = getSessionSectionsContentRoot();
    const overlay = new OverlayContentLayer(overlayRoot, canonicalRoot);

    const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, overlayRoot, canonicalRoot);
    const ydoc = new Y.Doc();

    const orderedKeys: string[] = [];
    skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
      const isBfh = headingPath.length === 0;
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBfh);
      const hp = [...headingPath];
      if (!orderedKeys.includes(fragmentKey)) {
        orderedKeys.push(fragmentKey);
      }
    });

    // Empty-doc bootstrap: seed the synthetic BFH key into the session index
    // BEFORE constructing LiveFragmentStringsStore so its orderedKeys match
    // the index and subsequent Y.Doc population lands on a key the session
    // already knows about. Matches the skeleton-backed path downstream: once
    // the user's first edit materializes a BFH section on disk, the real
    // skeleton walk will re-introduce the same key.
    if (skeleton.areSkeletonRootsEmpty) {
      orderedKeys.push(BEFORE_FIRST_HEADING_KEY);
    }

    const liveStrings = new LiveFragmentStringsStore(ydoc, orderedKeys, docPath);
    const rawRecovery = new RawFragmentRecoveryBuffer(docPath);
    const stagedSections = new StagedSectionsStore(docPath);
    liveStrings.attachRecoveryBuffer(rawRecovery);
    const newSession: DocSession = {
      state: "acquiring",
      ydoc,
      liveFragments: liveStrings,
      recoveryBuffer: rawRecovery,
      stagedSections: stagedSections,
      docPath,
      holders: new Map(),   // Callers add themselves after awaiting the promise
      presenceManager: new PresenceManager(),
      perUserDirty: new Map(),
      fragmentLastActivity: new Map(),
      fragmentFirstActivity: new Map(),
      lastActivityAt: Date.now(),
      lastEditPulse: new Map(),
      idleTimeoutTimer: null,
      createdAt: Date.now(),
      baseHead,
      lastWriterId: writerId,
      flushTimer: null,
      contributors: new Map(),
      docSessionId: crypto.randomUUID(),
      quiescencePolicy: null as unknown as SessionQuiescencePolicy,
    };
    newSession.quiescencePolicy = new SessionQuiescencePolicy(
      newSession,
      { idleTimeoutMs: IDLE_TIMEOUT_MS },
    );

    if (skeleton.areSkeletonRootsEmpty) {
      // Populate the Y.Doc with an empty BFH fragment using SERVER_INJECTION_ORIGIN
      // so the afterTransaction guard does not mark it ahead-of-staged.
      const bfhContent = buildFragmentContentFn(EMPTY_BODY, 0, "");
      const bootstrapMap = new Map<string, FragmentContent>();
      bootstrapMap.set(BEFORE_FIRST_HEADING_KEY, bfhContent);
      liveStrings.replaceFragmentStrings(bootstrapMap, SERVER_INJECTION_ORIGIN);
    }

    if (!skeleton.areSkeletonRootsEmpty) {
      // Read raw fragment files (sessions/fragments/) — crash-safe heading+body
      // format. These take precedence over body files when present.
      const rawFragmentKeys = await liveStrings.listPersistedFragmentKeys();
      const rawKeySet = new Set(rawFragmentKeys);
      const rawContentMap = new Map<string, string>();
      const rawWriterIdsMap = new Map<string, string[]>();
      for (const rawKey of rawFragmentKeys) {
        const content = await liveStrings.readPersistedFragment(rawKey);
        if (content !== null) rawContentMap.set(rawKey, content);
        rawWriterIdsMap.set(rawKey, await rawRecovery.readFragmentWriterIds(rawKey));
      }

      // Bulk-read overlay/canonical body content for the fall-back case
      const bulkContent = await overlay.readAllSections(docPath);

      // Build the caller-provided content map by walking the skeleton and
      // choosing per-section source from the runtime inputs above.
      const contentMap = new Map<string, FragmentContent>();
      const rawSourcedKeys: string[] = [];

      skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
        const fragmentKey = fragmentKeyFromSectionFile(sectionFile, headingPath.length === 0);

        if (rawKeySet.has(fragmentKey)) {
          // Raw fragment already contains heading + body — pass through
          contentMap.set(fragmentKey, fragmentFromDisk(rawContentMap.get(fragmentKey) ?? ""));
          liveStrings.setFragmentWriterIds(fragmentKey, rawWriterIdsMap.get(fragmentKey) ?? []);
          rawSourcedKeys.push(fragmentKey);
        } else {
          // Fall back to body-only file content
          const headingKey = SectionRef.headingKey([...headingPath]);
          const bodyContent = bulkContent?.get(headingKey) ?? EMPTY_BODY;
          contentMap.set(fragmentKey, buildFragmentContentFn(bodyContent, level, heading));
        }
      });

      // Single explicit multi-fragment apply step. Use SERVER_INJECTION_ORIGIN
      // so the afterTransaction listener doesn't mark all keys ahead-of-staged
      // from the initial population — only subsequent client edits should be dirty.
      liveStrings.replaceFragmentStrings(contentMap, SERVER_INJECTION_ORIGIN);

      // Sections sourced from raw fragments may carry structural drift
      // (level/heading changes that the on-disk normalizer didn't run yet).
      // Normalize them now so the live Y.Doc matches the skeleton invariants.
      for (const fragmentKey of rawSourcedKeys) {
        await settleFromLiveFragment(newSession, fragmentKey);
      }
    }

    sessions.set(docPath, newSession);
    return newSession;
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
  resetIdleTimeout(session);
  // "acquiring" → "active": session is fully initialised with its first editor holder
  session.state = "active";

  return session;
}

export interface ReleaseResult {
  sessionEnded: boolean;
  /** Populated when sessionEnded === true: all writers who contributed to this session. */
  contributors: WriterIdentity[];
  releasedSessionStores: {
    stagedSections: StagedSectionsStore;
    recoveryBuffer: RawFragmentRecoveryBuffer;
  } | null;
}

/**
 * Synchronous lifecycle boundary:
 * remove one editor-holder attachment and clear focus when the holder has no
 * remaining editor sockets. No async I/O is allowed in this method.
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
      session.presenceManager.clearFocus(writerId);
    }
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
  if (!session) return { sessionEnded: false, contributors: [], releasedSessionStores: null };
  await runSessionQuiescenceHolderChange(session, removal.lastEditorDetached);

  return {
    sessionEnded: session.state === "ended",
    contributors: [],
    releasedSessionStores: null,
  };
}

async function destroySessionWhenQuiescent(session: DocSession): Promise<void> {
  if (session.state !== "active") return;
  if (session.holders.size > 0) return;
  if (session.liveFragments.getAheadOfStagedKeys().size > 0) return;
  if (sessions.get(session.docPath) !== session) return;

  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  const inflight = rawSnapshotInFlight.get(session);
  if (inflight) {
    await inflight;
  }
  if (sessions.get(session.docPath) !== session) return;

  sessions.delete(session.docPath);
  sessionPromises.delete(session.docPath);

  if (session.idleTimeoutTimer) {
    clearTimeout(session.idleTimeoutTimer);
    session.idleTimeoutTimer = null;
  }

  session.state = "ended";
  session.ydoc.destroy();
}

// ─── Section Focus (editingPresence) ─────────────────────────────
// editingPresence: server-authoritative, drives agent blocking and
// human-involvement scoring. Never derived from Awareness CRDT.

export function updateSectionFocus(
  docPath: string,
  writerId: string,
  headingPath: string[],
): { oldFocus: string[] | null } {
  const session = sessions.get(docPath);
  if (!session) return { oldFocus: null };

  const { previous } = session.presenceManager.setFocus(writerId, headingPath);
  session.lastActivityAt = Date.now();
  session.lastWriterId = writerId;
  // Note: section focus alone no longer resets idle timeout.
  // Only ACTIVITY_PULSE resets it (the user must actually be typing).

  return { oldFocus: previous };
}

// ─── Removed session section index compatibility stubs ───────────

/**
 * Deprecated: session-owned heading-path lookup was deleted. Production code
 * must resolve section identity through document-owning boundaries.
 */
export function findKeyForHeadingPath(_session: DocSession, _headingPath: string[]): string | null {
  return null;
}

/**
 * Deprecated: session-owned heading-path lookup was deleted. Production code
 * must resolve section identity through document-owning boundaries.
 */
export function requireKeyForHeadingPath(session: DocSession, headingPath: string[]): string {
  throw new Error(
    `Session section index was removed for "${session.docPath}"; cannot resolve headingPath=[${headingPath.join(" > ")}] synchronously.`,
  );
}

/**
 * Deprecated: session-owned heading-path lookup was deleted. Production code
 * must resolve section identity through document-owning boundaries.
 */
export function findHeadingPathForKey(_session: DocSession, _fragmentKey: string): string[] | null {
  return null;
}

/**
 * Deprecated: session-owned heading-path lookup was deleted. Production code
 * must resolve section identity through document-owning boundaries.
 */
export function findHeadingPathsForKey(_session: DocSession, _fragmentKey: string): string[][] {
  return [];
}

/**
 * Deprecated: session-owned heading-path lookup was deleted. Production code
 * must resolve section identity through document-owning boundaries.
 */
export function requireHeadingPathForKey(session: DocSession, fragmentKey: string): string[] {
  throw new Error(
    `Session section index was removed for "${session.docPath}"; cannot resolve fragmentKey="${fragmentKey}" synchronously.`,
  );
}

/**
 * Transitional compatibility surface for old callers. Overlay accepts no
 * longer imply any live Y.Doc rewrite or session index rebuild.
 */
export async function applyAcceptResult(
  session: DocSession,
  result: AcceptResult,
): Promise<void> {
  if ((result.writtenSectionRefs?.length ?? 0) === 0 && result.deletedKeys.length === 0) {
    return;
  }
  const { OverlayContentLayer } = await import("../storage/content-layer.js");
  const overlay = new OverlayContentLayer(getSessionSectionsContentRoot(), getContentRoot());
  const rewrittenFragments: Array<{
    fragmentKey: string;
    content: FragmentContent | string;
    writerIds: string[];
  }> = [];

  for (const ref of result.writtenSectionRefs ?? []) {
    const sectionRef = new SectionRef(ref.docPath, ref.headingPath);
    const body = await overlay.readSection(sectionRef);
    const { absolutePath, level } = await overlay.resolveSectionPathWithLevel(ref.docPath, ref.headingPath);
    const sectionFile = path.basename(absolutePath, ".md");
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, ref.headingPath.length === 0);
    rewrittenFragments.push({
      fragmentKey,
      content: buildFragmentContentFn(body, level, ref.headingPath[ref.headingPath.length - 1] ?? ""),
      writerIds: session.liveFragments.getWriterIdsForFragment(fragmentKey),
    });
  }

  await session.recoveryBuffer.applyStructuralRewrite(result.deletedKeys, rewrittenFragments);
}

async function settleFromLiveFragment(
  session: DocSession,
  fragmentKey: string,
): Promise<SettleResult> {
  const settleResult = await session.liveFragments.settleFragment(session.stagedSections, fragmentKey);
  if (!settleResult.staleOverlay) {
    await applyAcceptResult(session, settleResult);
    remapDeletedDirtyFragmentKeysAfterSettle(session, settleResult);
    session.liveFragments.clearAheadOfStaged(settleResult.acceptedKeys);
  }
  return settleResult;
}

function remapDeletedDirtyFragmentKeysAfterSettle(
  session: DocSession,
  settleResult: SettleResult,
): void {
  const deletedKeys = [...new Set(settleResult.deletedKeys)];
  if (deletedKeys.length === 0) return;

  const writtenKeys = [...new Set(settleResult.writtenKeys)];

  for (const dirtySet of session.perUserDirty.values()) {
    let intersectsDeleted = false;
    for (const deletedKey of deletedKeys) {
      if (dirtySet.has(deletedKey)) {
        intersectsDeleted = true;
        break;
      }
    }
    if (!intersectsDeleted) continue;

    for (const deletedKey of deletedKeys) {
      dirtySet.delete(deletedKey);
    }
    for (const writtenKey of writtenKeys) {
      dirtySet.add(writtenKey);
    }
  }

  if (writtenKeys.length === 0) return;

  let earliestFirstActivity: number | null = null;
  let latestLastActivity: number | null = null;
  for (const deletedKey of deletedKeys) {
    const firstActivity = session.fragmentFirstActivity.get(deletedKey) ?? null;
    if (firstActivity != null && (earliestFirstActivity == null || firstActivity < earliestFirstActivity)) {
      earliestFirstActivity = firstActivity;
    }
    const lastActivity = session.fragmentLastActivity.get(deletedKey) ?? null;
    if (lastActivity != null && (latestLastActivity == null || lastActivity > latestLastActivity)) {
      latestLastActivity = lastActivity;
    }
  }

  for (const writtenKey of writtenKeys) {
    if (earliestFirstActivity != null) {
      const existingFirst = session.fragmentFirstActivity.get(writtenKey) ?? null;
      if (existingFirst == null || earliestFirstActivity < existingFirst) {
        session.fragmentFirstActivity.set(writtenKey, earliestFirstActivity);
      }
    }
    if (latestLastActivity != null) {
      const existingLast = session.fragmentLastActivity.get(writtenKey) ?? null;
      if (existingLast == null || latestLastActivity > existingLast) {
        session.fragmentLastActivity.set(writtenKey, latestLastActivity);
      }
    }
  }
}

function collectQuiescentFragmentKeys(session: DocSession, nowMs: number): string[] {
  return [...session.liveFragments.getAheadOfStagedKeys()]
    .filter((fragmentKey) => session.quiescencePolicy.isFragmentQuiescent(fragmentKey, nowMs));
}

async function runSessionQuiescencePass(
  session: DocSession,
  nowMs: number,
): Promise<void> {
  const quietKeys = collectQuiescentFragmentKeys(session, nowMs);
  if (quietKeys.length > 0) {
    await settleFragmentKeysFromLive(session, quietKeys);
  }
  if (session.quiescencePolicy.shouldTearDownDoc(nowMs)) {
    await destroySessionWhenQuiescent(session);
  }
}

async function runSessionQuiescenceHolderChange(
  session: DocSession,
  lastEditorDetached: boolean,
  nowMs = Date.now(),
): Promise<void> {
  if (!lastEditorDetached) return;
  await runSessionQuiescencePass(session, nowMs);
}

export async function runSessionQuiescenceIdleTick(
  session: DocSession,
  nowMs = Date.now(),
): Promise<{ shouldTriggerIdleTimeout: boolean }> {
  const shouldTriggerIdleTimeout = session.quiescencePolicy.shouldTriggerIdleTimeout(nowMs);
  if (shouldTriggerIdleTimeout) {
    await runSessionQuiescencePass(session, nowMs);
  }
  return { shouldTriggerIdleTimeout };
}

export async function settleFragmentKeysFromLive(
  session: DocSession,
  fragmentKeys: Iterable<string>,
): Promise<{
  writtenKeys: string[];
  deletedKeys: string[];
  staleKeys: string[];
  writtenSectionRefs: Array<{ docPath: string; headingPath: string[] }>;
  deletedSectionRefs: Array<{ docPath: string; headingPath: string[] }>;
}> {
  const writtenKeys: string[] = [];
  const deletedKeys: string[] = [];
  const staleKeys: string[] = [];
  const writtenSectionRefMap = new Map<string, { docPath: string; headingPath: string[] }>();
  const deletedSectionRefMap = new Map<string, { docPath: string; headingPath: string[] }>();
  const noteSectionRef = (
    target: Map<string, { docPath: string; headingPath: string[] }>,
    ref: { docPath: string; headingPath: string[] },
  ): void => {
    target.set(`${ref.docPath}\0${SectionRef.headingKey(ref.headingPath)}`, {
      docPath: ref.docPath,
      headingPath: [...ref.headingPath],
    });
  };

  for (const fragmentKey of fragmentKeys) {
    if (!session.liveFragments.isAheadOfStaged(fragmentKey)) continue;
    const settleResult = await settleFromLiveFragment(session, fragmentKey);
    if (settleResult.staleOverlay) {
      staleKeys.push(fragmentKey);
      continue;
    }
    writtenKeys.push(...settleResult.writtenKeys);
    deletedKeys.push(...settleResult.deletedKeys);
    for (const ref of settleResult.writtenSectionRefs ?? []) {
      noteSectionRef(writtenSectionRefMap, ref);
    }
    for (const ref of settleResult.deletedSectionRefs ?? []) {
      noteSectionRef(deletedSectionRefMap, ref);
    }
  }

  return {
    writtenKeys,
    deletedKeys,
    staleKeys,
    writtenSectionRefs: [...writtenSectionRefMap.values()],
    deletedSectionRefs: [...deletedSectionRefMap.values()],
  };
}

// ─── Per-user dirty tracking ─────────────────────────────────────

/**
 * Mark a fragment as dirty for a specific writer.
 * Returns true if this is the first time this fragment is dirtied for this
 * writer (i.e. a state transition happened), false if already dirty.
 */
export function markFragmentDirty(
  docPath: string,
  writerId: string,
  fragmentKey: string,
): boolean {
  const session = sessions.get(docPath);
  if (!session) return false;

  assertState(session, ["active", "flushing"]);

  if (!session.perUserDirty.has(writerId)) {
    session.perUserDirty.set(writerId, new Set());
  }
  const dirtySet = session.perUserDirty.get(writerId)!;
  const isNew = !dirtySet.has(fragmentKey);
  dirtySet.add(fragmentKey);
  const now = Date.now();
  session.fragmentLastActivity.set(fragmentKey, now);
  if (!session.fragmentFirstActivity.has(fragmentKey)) {
    session.fragmentFirstActivity.set(fragmentKey, now);
  }
  session.lastWriterId = writerId;
  session.lastActivityAt = Date.now();
  return isNew;
}

// ─── Normalization ───────────────────────────────────────────────

// ─── Join (atomic sync + presence replay) ────────────────────────

/** MSG_SYNC_STEP_1 byte value — must match crdt-sync.ts. */
const MSG_SYNC_STEP_1_BYTE = 0x00;

/** MSG_SYNC_STEP_2 byte value — must match crdt-sync.ts. */
const MSG_SYNC_STEP_2_BYTE = 0x01;

/**
 * Perform the atomic join sequence for an editor or observer connecting to a session:
 *   1. Send SYNC_STEP_2 with the full Y.Doc state (encoded against an empty state vector) so the
 *      client receives all current content immediately, regardless of whether it has ever sent
 *      its own SYNC_STEP_1. This is critical for pre-connected observers whose SYNC_STEP_1 was
 *      dropped because no session existed at the time they connected — without this push, their
 *      Y.Doc stays empty, _synced never becomes true, and scheduleOnChange silently discards
 *      every subsequent MSG_YJS_UPDATE.
 *   2. Send SYNC_STEP_1 (server's state vector) so the client can contribute any local state it
 *      holds that the server lacks (relevant for reconnecting editors with offline work).
 *   3. Immediately — in the same synchronous turn, with no await between — replay all current
 *      presence state via emitPresenceEvent.
 *
 * The atomicity guarantee: no presence update can arrive between step 2 and step 3 because
 * there is no async yield. A late-joining client therefore sees a consistent snapshot: the
 * full Y.Doc state AND the current presence state with no gap.
 *
 * Y.applyUpdate is idempotent: clients that also receive SYNC_STEP_2 via the normal
 * handleMessage path (server responding to the client's own SYNC_STEP_1) are unaffected.
 *
 * @param session - The active DocSession to join.
 * @param sendRaw - Sends a raw binary message to the joining socket.
 * @param emitPresenceEvent - Emits a WsServerEvent (typically via onWsEvent → hub broadcast).
 */
export function joinSession(
  session: DocSession,
  sendRaw: (msg: Uint8Array) => void,
  emitPresenceEvent: (event: WsServerEvent) => void,
): void {
  assertState(session, ["active"]);

  // Step 1: Push full Y.Doc state to the joining socket so it receives all content immediately.
  // Pre-connected observers whose SYNC_STEP_1 was dropped (no session existed yet) depend on this.
  const fullUpdate = Y.encodeStateAsUpdate(session.ydoc);
  const syncStep2 = new Uint8Array(1 + fullUpdate.length);
  syncStep2[0] = MSG_SYNC_STEP_2_BYTE;
  syncStep2.set(fullUpdate, 1);
  sendRaw(syncStep2);

  // Step 2: Send SYNC_STEP_1 so the client can contribute any local state the server lacks
  const sv = Y.encodeStateVector(session.ydoc);
  const syncStep1 = new Uint8Array(1 + sv.length);
  syncStep1[0] = MSG_SYNC_STEP_1_BYTE;
  syncStep1.set(sv, 1);
  sendRaw(syncStep1);

  // Step 3: Replay presence state (synchronous — no async yield from step 2 to here)
  for (const [writerId, headingPath] of session.presenceManager.getAll()) {
    const holder = session.holders.get(writerId);
    if (!holder) {
      throw new Error(`Presence replay missing holder identity for writer "${writerId}" on doc "${session.docPath}".`);
    }
    emitPresenceEvent({
      type: "presence:editing",
      doc_path: session.docPath,
      writer_id: writerId,
      writer_display_name: holder.identity.displayName,
      writer_type: holder.identity.type,
      heading_path: headingPath,
    });
  }
}

// ─── Contributor tracking ─────────────────────────────────────────

/**
 * Record a writer as a contributor to this session.
 * Called when a MSG_ACTIVITY_PULSE is received — the unambiguous signal that
 * the writer is actively producing edits during this session.
 */
export function addContributor(docPath: string, writerId: string, identity: WriterIdentity): void {
  const session = sessions.get(docPath);
  if (!session) return;
  if (!session.contributors.has(writerId)) {
    session.contributors.set(writerId, identity);
  }
}

// ─── Observer holder management ──────────────────────────────────

/** Count the total number of live editor sockets across all holders in a session. */
export function countEditorSockets(session: DocSession): number {
  let count = 0;
  for (const h of session.holders.values()) count += h.editorSocketIds.size;
  return count;
}

/**
 * Add an observer socket to a session's holders map.
 * The broken `if (!session.holders.has(writerId))` guard is removed — it would silently
 * skip an observer connect when an editor entry for the same user already exists.
 */
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

/**
 * Remove an observer socket from a session's holders map.
 * Deletes the holder entry only when both editor and observer socket sets are empty.
 */
export function removeObserverHolder(docPath: string, writerId: string, socketId?: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  const holder = session.holders.get(writerId);
  if (!holder) return;
  if (socketId) holder.observerSocketIds.delete(socketId);
  if (holder.editorSocketIds.size === 0 && holder.observerSocketIds.size === 0) {
    session.holders.delete(writerId);
    session.presenceManager.clearFocus(writerId);
  }
}

/**
 * Flush all ahead-of-staged keys through the store boundary pipeline:
 * live-store settle → applyAcceptResult. Used by tests and perf
 * benchmarks. Production flush is in the coordinator (adds two-tier
 * structural-cleanliness gating and WebSocket broadcast).
 */
export async function flushDirtyToOverlay(session: DocSession): Promise<void> {
  const scope = session.liveFragments.getAheadOfStagedKeys();
  if (scope.size === 0) return;
  await settleFragmentKeysFromLive(session, scope);
}

/**
 * Collect fragment keys that should be normalized at session end/shutdown.
 *
 * Uses `perUserDirty` as the single dirty-tracking source (BNATIVE.10).
 * `fragments.dirtyKeys` is eliminated — `liveFragments.aheadOfStagedKeys`
 * handles the debounced flush pipeline separately, and `perUserDirty` is the
 * session-scoped attribution that drives normalization scope.
 */
export function collectTouchedFragmentKeysForNormalization(session: DocSession): Set<string> {
  const keys = new Set<string>();
  for (const dirtySet of session.perUserDirty.values()) {
    for (const key of dirtySet) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Normalize all fragments in a session that have embedded headings.
 * Called on disconnect (after flush) and shutdown.
 *
 * Uses the store boundary pattern: live-store settle on the chosen scope,
 * then apply the resulting accept result.
 */
export async function normalizeAllFragments(session: DocSession): Promise<void> {
  // Snapshot keys upfront — normalization may mutate the key set.
  const keys = session.liveFragments.getFragmentKeys();
  await settleFragmentKeysFromLive(session, keys);
}

/**
 * Normalize a specific subset of fragment keys in a session.
 * Used by scoped publish flows so unrelated sections are not touched.
 *
 * Skips keys whose entry no longer exists in the skeleton — normalization can
 * remove keys mid-loop (e.g., heading deletion merges into a sibling).
 *
 * Uses the store boundary pattern: live-store settle on the chosen scope,
 * then apply the resulting accept result.
 */
export async function normalizeFragmentKeys(
  session: DocSession,
  fragmentKeys: Set<string>,
): Promise<void> {
  // Filter to keys that still exist in the session index.
  const validKeys = new Set<string>();
  for (const key of fragmentKeys) {
    if (session.liveFragments.hasFragmentKey(key)) {
      validKeys.add(key);
    }
  }
  if (validKeys.size === 0) return;
  await settleFragmentKeysFromLive(session, validKeys);
}

/**
 * Normalize a single fragment by key. Called on focus change (left fragment).
 *
 * Uses the store boundary pattern: live-store settle on the chosen scope,
 * then apply the resulting accept result.
 */
export async function normalizeFragment(docPath: string, fragmentKey: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;
  await settleFragmentKeysFromLive(session, [fragmentKey]);
}

// ─── Debounced flush ─────────────────────────────────────────────

const rawSnapshotInFlight = new WeakMap<DocSession, Promise<void>>();

async function snapshotDirtyFragmentsToRaw(session: DocSession): Promise<void> {
  if (session.state !== "active") return;
  if (rawSnapshotInFlight.has(session)) return;

  session.state = "flushing";
  const promise = (async () => {
    try {
      await session.liveFragments.snapshotToRecovery("all");
    } finally {
      rawSnapshotInFlight.delete(session);
      if (session.state === "flushing") {
        session.state = "active";
      }
    }
  })();
  rawSnapshotInFlight.set(session, promise);
  await promise;
}

export function triggerDebouncedRawFragmentSnapshot(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;

  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
  }
  session.flushTimer = setTimeout(() => {
    session.flushTimer = null;
    void snapshotDirtyFragmentsToRaw(session);
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Legacy compatibility surface. Session-overlay import callbacks are removed;
 * settle decisions are policy-owned.
 */
export interface SessionOverlayImportCallback {
  (session: DocSession): Promise<void>;
}

export function setSessionOverlayImportCallback(_cb: SessionOverlayImportCallback): void {
  // Intentionally no-op.
}

export function triggerDebouncedSessionOverlayImport(docPath: string): void {
  triggerDebouncedRawFragmentSnapshot(docPath);
}

export function triggerImmediateSessionOverlayImport(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  void snapshotDirtyFragmentsToRaw(session);
}

export async function pauseSessionOverlayImport(docPath: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  const inflight = rawSnapshotInFlight.get(session);
  if (inflight) {
    await inflight;
  }
}

// ─── Idle timeout ────────────────────────────────────────────────

let _onIdleTimeout: ((docPath: string) => void) | null = null;

export function setIdleTimeoutHandler(handler: (docPath: string) => void): void {
  _onIdleTimeout = handler;
}

function resetIdleTimeout(session: DocSession): void {
  if (session.idleTimeoutTimer) {
    clearTimeout(session.idleTimeoutTimer);
  }
  session.idleTimeoutTimer = setTimeout(async () => {
    // Skip if session is already ended.
    if (session.state === "ended") return;
    // Reschedule if flush is in-flight — don't force-close while flushing.
    if (session.state === "flushing") {
      resetIdleTimeout(session);
      return;
    }
    // Assert "active" — any other state here is unexpected.
    assertState(session, ["active"]);
    const idleDecision = await runSessionQuiescenceIdleTick(session);
    if (_onIdleTimeout && idleDecision.shouldTriggerIdleTimeout) {
      _onIdleTimeout(session.docPath);
    }
  }, IDLE_TIMEOUT_MS);
}

// ─── Activity ────────────────────────────────────────────────────

export function updateActivity(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  session.lastActivityAt = Date.now();
  // Note: awareness/cursor updates no longer reset idle timeout.
  // Only ACTIVITY_PULSE resets it (see updateEditPulse).
}

// ─── Edit Pulse ──────────────────────────────────────────────────

/**
 * Record an ACTIVITY_PULSE from a writer — the unambiguous signal that
 * the human is actively producing edits (not just moving cursors).
 * This is the ONLY signal that resets the idle timeout.
 */
export function updateEditPulse(docPath: string, writerId: string): void {
  const session = sessions.get(docPath);
  if (!session) return;
  const now = Date.now();
  session.lastEditPulse.set(writerId, now);
  session.lastActivityAt = now;
  session.lastWriterId = writerId;
  resetIdleTimeout(session);
}

/**
 * Get the most recent edit pulse timestamp across all writers for a document.
 * Returns null if no pulses have been received.
 */
export function getLatestEditPulse(docPath: string): number | null {
  const session = sessions.get(docPath);
  if (!session || session.lastEditPulse.size === 0) return null;
  let latest = 0;
  for (const ts of session.lastEditPulse.values()) {
    if (ts > latest) latest = ts;
  }
  return latest;
}

/**
 * Get the most recent edit pulse timestamp for a specific section.
 * Uses writer's current focus to determine if the pulse applies to this section.
 * Returns null if no matching pulse found.
 */
export function getSectionEditPulse(
  ref: SectionRef,
): number | null {
  const session = sessions.get(ref.docPath);
  if (!session) return null;

  let latest: number | null = null;
  for (const [writerId, focusedPath] of session.presenceManager.getAll().entries()) {
    if (!ref.matchesHeadingPath(focusedPath)) continue;

    const pulseTs = session.lastEditPulse.get(writerId);
    if (pulseTs != null && (latest == null || pulseTs > latest)) {
      latest = pulseTs;
    }
  }
  return latest;
}

// ─── Cleanup ─────────────────────────────────────────────────────

export function destroyAllSessions(): void {
  for (const session of sessions.values()) {
    if (session.idleTimeoutTimer) clearTimeout(session.idleTimeoutTimer);
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.ydoc.destroy();
  }
  sessions.clear();
  sessionPromises.clear();
}

/**
 * Flush all active sessions and destroy them. Used at shutdown.
 */
export async function flushAndDestroyAll(): Promise<void> {
  for (const session of sessions.values()) {
    // Cancel pending debounce — we flush immediately
    if (session.flushTimer) clearTimeout(session.flushTimer);
    // Session-end store boundary: single accept with scoped dirty keys.
    const normalizeScope = collectTouchedFragmentKeysForNormalization(session);
    if (normalizeScope.size > 0) {
      await settleFragmentKeysFromLive(session, normalizeScope);
    }
    if (session.idleTimeoutTimer) clearTimeout(session.idleTimeoutTimer);
    session.ydoc.destroy();
  }
  sessions.clear();
  sessionPromises.clear();
}

// ─── Per-fragment activity lookup ─────────────────────────────────

export async function getSessionFileMtime(sectionKey: string): Promise<number | null> {
  const parts = sectionKey.split("::");
  if (parts.length < 1) return null;
  const docPath = parts[0];
  const headingPart = parts.length > 1 ? parts.slice(1).join("::") : "";
  const headingPath = headingPart ? headingPart.split(">>") : [];

  // Section recency is section-owned: resolve the effective overlay/canonical
  // section file and read its mtime directly from disk.
  const sessionSectionsContentRoot = getSessionSectionsContentRoot();

  try {
    const { OverlayContentLayer } = await import("../storage/content-layer.js");
    const layer = new OverlayContentLayer(sessionSectionsContentRoot, getContentRoot());
    const filePath = await layer.resolveSectionPath(docPath, headingPath);
    const { stat } = await import("node:fs/promises");
    const stats = await stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

// ─── Session replacement invalidation ────────────────────────────

/**
 * Return the pending replacement notice for reconnecting clients on docPath.
 * Returns null if no notice exists or if it has expired.
 * Does NOT consume the entry — multiple reconnecting clients must each receive it.
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
  return {
    message: entry.message,
  };
}

/**
 * Invalidate the live session for a document replaced by restore or overwrite.
 *
 * Steps:
 *   1. Store any pending reconnect notice before closing sockets, so it is
 *      available the instant clients begin reconnecting.
 *   2. Broadcast close code 4022 to all connected sockets (via callback).
 *   3. Destroy the live session synchronously. Any required pre-commit already
 *      happened at the route/store boundary before calling this.
 */
export async function invalidateSessionForReplacement(
  docPath: string,
  notice: DocumentReplacementNoticePayload | null,
): Promise<void> {
  // Store the pending notice FIRST so reconnecting clients can read it immediately.
  if (notice) {
    pendingReplacementNotices.set(docPath, {
      message: notice.message,
      expiresAt: Date.now() + REPLACEMENT_NOTICE_TTL_MS,
    });
  } else {
    pendingReplacementNotices.delete(docPath);
  }

  // Close all connected sockets with code 4022 (non-blocking).
  if (_broadcastSessionReplacementInvalidation) {
    _broadcastSessionReplacementInvalidation(docPath);
  }

  // Destroy the live session after any in-flight overlay import completes.
  const session = sessions.get(docPath);
  if (session) {
    assertState(session, ["active", "flushing"]);
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    const inflight = rawSnapshotInFlight.get(session);
    if (inflight) {
      await inflight;
    }
    if (session.idleTimeoutTimer) {
      clearTimeout(session.idleTimeoutTimer);
      session.idleTimeoutTimer = null;
    }
    const { teardownSessionStores } = await import("../storage/restore-teardown.js");
    await teardownSessionStores(session.liveFragments, session.stagedSections, session.recoveryBuffer);
    session.state = "ended";
    session.ydoc.destroy();
    sessions.delete(docPath);
    sessionPromises.delete(docPath);
  }
}