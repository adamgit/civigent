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
import { writeFile, readFile, mkdir, readdir, rm } from "node:fs/promises";
import * as Y from "yjs";
import { getContentRoot, getSessionSectionsContentRoot, getSessionAuthorsRoot } from "../storage/data-root.js";
import type {
  WriterIdentity,
  WsServerEvent,
  RestoreNotificationPayload,
  DocSessionId,
} from "../types/shared.js";
import type { PreemptiveCommitResult } from "../storage/auto-commit.js";
import { LiveFragmentStringsStore, SERVER_INJECTION_ORIGIN } from "./live-fragment-strings-store.js";
import { RawFragmentRecoveryBuffer } from "../storage/raw-fragment-recovery-buffer.js";
import { StagedSectionsStore, type AcceptResult } from "../storage/staged-sections-store.js";
import { PresenceManager } from "./presence-manager.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  EMPTY_BODY,
  buildFragmentContent as buildFragmentContentFn,
  type FragmentContent,
} from "../storage/section-formatting.js";
import { fragmentKeyFromSectionFile } from "./ydoc-fragments.js";

export { SERVER_INJECTION_ORIGIN };

// ─── Session state machine ───────────────────────────────────────

export type SessionState = "acquiring" | "active" | "flushing" | "committing" | "ended";

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
  /** Bidirectional index: fragment key → heading path. Authoritative after BNATIVE.10.
   *  Built at acquisition from skeleton walk, updated from AcceptResult.updatedIndex. */
  headingPathByFragmentKey: Map<string, string[]>;
  /** Bidirectional index: heading-path key (joined with ">>") → fragment key. */
  fragmentKeyByHeadingPathKey: Map<string, string>;
  /** Ordered fragment keys matching the document's section order. */
  orderedFragmentKeys: string[];
  /** All connected participants (editors + observers) keyed by writerId. */
  holders: Map<string, HolderEntry>;
  /** Server-authoritative section focus. Set from SECTION_FOCUS binary messages in crdt-sync.ts. */
  presenceManager: PresenceManager;
  /** Tracks *which* sections each writer has changed (for Mirror panel attribution
   *  and commit scoping). Complementary to lastEditPulse — this records *what* was
   *  changed, while lastEditPulse records *when* the user last actively typed. */
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

// ─── Pending restore notifications ───────────────────────────────

interface PendingRestoreNotification {
  restoreSha: string;
  restoredByDisplayName: string;
  /** writerId → personalised data; absent means unaffected writer. */
  affectedWriters: Map<string, { preCommitSha: string; dirtyHeadingPaths: string[][] }>;
  expiresAt: number;
}

const pendingRestoreNotifications = new Map<string, PendingRestoreNotification>();
const RESTORE_NOTIFICATION_TTL_MS = 5 * 60 * 1000;

let _broadcastRestoreInvalidation: ((docPath: string) => void) | null = null;

export function setBroadcastRestoreInvalidation(cb: (docPath: string) => void): void {
  _broadcastRestoreInvalidation = cb;
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

export interface SessionOverlayImportCallback {
  (session: DocSession): Promise<void>;
}

let _sessionOverlayImportCallback: SessionOverlayImportCallback | null = null;

export function setSessionOverlayImportCallback(cb: SessionOverlayImportCallback): void {
  _sessionOverlayImportCallback = cb;
}

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
  //      (raw fragments are freshest; fall back to overlay/canonical body)
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

    // BNATIVE.9/10: derive orderedKeys + bidirectional index from skeleton walk.
    const orderedKeys: string[] = [];
    const headingPathByFragmentKey = new Map<string, string[]>();
    const fragmentKeyByHeadingPathKey = new Map<string, string>();
    skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
      const isBfh = headingPath.length === 0;
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBfh);
      orderedKeys.push(fragmentKey);
      const hp = [...headingPath];
      headingPathByFragmentKey.set(fragmentKey, hp);
      fragmentKeyByHeadingPathKey.set(SectionRef.headingKey(hp), fragmentKey);
    });

    const liveStrings = new LiveFragmentStringsStore(ydoc, orderedKeys, docPath);
    const rawRecovery = new RawFragmentRecoveryBuffer(docPath);
    const stagedSections = new StagedSectionsStore(docPath);

    if (!skeleton.areSkeletonRootsEmpty) {
      // Read raw fragment files (sessions/fragments/) — crash-safe heading+body
      // format. These take precedence over body files when present.
      const rawFragmentKeys = await rawRecovery.listFragmentKeys();
      const rawKeySet = new Set(rawFragmentKeys);
      const rawContentMap = new Map<string, string>();
      for (const rawKey of rawFragmentKeys) {
        const content = await rawRecovery.readFragment(rawKey);
        if (content !== null) rawContentMap.set(rawKey, content);
      }

      // Bulk-read overlay/canonical body content for the fall-back case
      const bulkContent = await overlay.readAllSections(docPath);

      // Build the caller-provided content map by walking the skeleton and
      // choosing per-section source from the runtime inputs above.
      const contentMap = new Map<string, FragmentContent>();
      const rawSourcedKeys: string[] = [];

      skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
        const hpKey = SectionRef.headingKey([...headingPath]);
        const fragmentKey = fragmentKeyByHeadingPathKey.get(hpKey);
        if (!fragmentKey) {
          throw new Error(`No fragment key for headingPath=[${headingPath.join(" > ")}] in "${docPath}".`);
        }

        if (rawKeySet.has(fragmentKey)) {
          // Raw fragment already contains heading + body — pass through
          contentMap.set(fragmentKey, fragmentFromDisk(rawContentMap.get(fragmentKey) ?? ""));
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
        liveStrings.noteAheadOfStaged(fragmentKey);
        const rawMarkdown = liveStrings.readFragmentString(fragmentKey);
        await rawRecovery.writeFragment(fragmentKey, rawMarkdown);
        const scope = new Set<string>([fragmentKey]);
        const acceptResult = await stagedSections.acceptLiveFragments(liveStrings, scope);
        if (acceptResult.structuralChange) {
          liveStrings.applyStructuralChange(acceptResult.structuralChange);
          if (acceptResult.updatedIndex) {
            headingPathByFragmentKey.clear();
            fragmentKeyByHeadingPathKey.clear();
            orderedKeys.length = 0;
            for (const entry of acceptResult.updatedIndex) {
              const hp = [...entry.headingPath];
              headingPathByFragmentKey.set(entry.fragmentKey, hp);
              fragmentKeyByHeadingPathKey.set(SectionRef.headingKey(hp), entry.fragmentKey);
              orderedKeys.push(entry.fragmentKey);
            }
          }
          for (const removedKey of acceptResult.structuralChange.removedKeys) {
            await rawRecovery.deleteFragment(removedKey);
          }
          for (const [reloadKey, content] of acceptResult.structuralChange.contentByKey) {
            await rawRecovery.writeFragment(reloadKey, content);
          }
        }
      }
    }

    const newSession: DocSession = {
      state: "acquiring",
      ydoc,
      liveFragments: liveStrings,
      recoveryBuffer: rawRecovery,
      stagedSections: stagedSections,
      docPath,
      headingPathByFragmentKey,
      fragmentKeyByHeadingPathKey,
      orderedFragmentKeys: orderedKeys,
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
    };

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
}

export async function releaseDocSession(
  docPath: string,
  writerId: string,
  socketId?: string,
): Promise<ReleaseResult> {
  const session = sessions.get(docPath);
  if (!session) return { sessionEnded: false, contributors: [] };

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

  if (countEditorSockets(session) === 0) {
    // Cancel pending debounce
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }

    // If an import is currently in-flight (state === "flushing"), wait for it to complete
    // before taking exclusive "committing" ownership of the session.
    if (session.state === "flushing") {
      const inflight = sessionOverlayImportInFlight.get(session);
      if (inflight) await inflight;
      // After awaiting, state has transitioned back to "active" (in import finally block).
    }

    // Guard against double-commit (e.g., two concurrent close events for the last editor).
    assertState(session, ["active"]);
    // "active" → "committing": last editor disconnected, teardown begins.
    session.state = "committing";

    // Capture contributors before session is destroyed.
    const contributors = Array.from(session.contributors.values());

    try {
      // Session-end store boundary pattern: single accept with scoped dirty keys
      // that both flushes body-only changes and runs structural normalization.
      // Replaces the legacy two-step (import callback + normalizeFragmentKeys).
      //
      // Scope to dirty keys only — normalizing untouched sections can corrupt
      // unrelated content with malformed headings (Bug A).
      const normalizeScope = collectTouchedFragmentKeysForNormalization(session);
      for (const key of normalizeScope) {
        session.liveFragments.noteAheadOfStaged(key);
      }
      if (normalizeScope.size > 0) {
        await session.recoveryBuffer.snapshotFromLive(session.liveFragments, normalizeScope);
        const result = await session.stagedSections.acceptLiveFragments(session.liveFragments, normalizeScope);
        await applyAcceptResult(session, result);
      }
    } finally {
      // Always clean up timers and destroy Y.Doc, even if normalization fails
      if (session.idleTimeoutTimer) {
        clearTimeout(session.idleTimeoutTimer);
      }

      // "committing" → "ended": teardown complete.
      session.state = "ended";
      session.ydoc.destroy();
      sessions.delete(docPath);
      sessionPromises.delete(docPath);
    }

    return { sessionEnded: true, contributors };
  }

  return { sessionEnded: false, contributors: [] };
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

// ─── Fragment key ↔ heading path lookup ──────────────────────────

/**
 * Session-level bidirectional index accessors. Read directly from DocSession's
 * own index (built from skeleton at acquisition, updated from
 * AcceptResult.updatedIndex after structural changes).
 */
export function findKeyForHeadingPath(session: DocSession, headingPath: string[]): string | null {
  return session.fragmentKeyByHeadingPathKey.get(SectionRef.headingKey([...headingPath])) ?? null;
}

export function requireKeyForHeadingPath(session: DocSession, headingPath: string[]): string {
  const key = findKeyForHeadingPath(session, headingPath);
  if (key) return key;
  throw new Error(
    `No live fragment key exists for headingPath=[${headingPath.join(" > ")}] in "${session.docPath}".`,
  );
}

export function findHeadingPathForKey(session: DocSession, fragmentKey: string): string[] | null {
  const hp = session.headingPathByFragmentKey.get(fragmentKey);
  return hp ? [...hp] : null;
}

export function requireHeadingPathForKey(session: DocSession, fragmentKey: string): string[] {
  const hp = findHeadingPathForKey(session, fragmentKey);
  if (hp) return hp;
  throw new Error(
    `No live heading path exists for fragmentKey="${fragmentKey}" in "${session.docPath}".`,
  );
}

/**
 * Apply the result of `stagedSections.acceptLiveFragments(...)` back onto
 * the DocSession: reconcile the live Y.Doc, rebuild DocSession's index from
 * updatedIndex, rebuild DocSession's bidirectional heading-path index,
 * update raw recovery files for structural changes, and broadcast remaps.
 */
export async function applyAcceptResult(
  session: DocSession,
  result: AcceptResult,
): Promise<void> {
  if (result.structuralChange) {
    // (1) Reconcile the live Y.Doc with the new fragment layout.
    session.liveFragments.applyStructuralChange(result.structuralChange);

    // (2) Rebuild DocSession's authoritative index from updatedIndex.
    if (result.updatedIndex) {
      session.headingPathByFragmentKey.clear();
      session.fragmentKeyByHeadingPathKey.clear();
      session.orderedFragmentKeys = [];
      for (const entry of result.updatedIndex) {
        const hp = [...entry.headingPath];
        session.headingPathByFragmentKey.set(entry.fragmentKey, hp);
        session.fragmentKeyByHeadingPathKey.set(SectionRef.headingKey(hp), entry.fragmentKey);
        session.orderedFragmentKeys.push(entry.fragmentKey);
      }
    }

    // (3) Update raw recovery: delete files for removed keys, rewrite for
    // restructured content so crash recovery sees the current fragment layout.
    for (const removedKey of result.structuralChange.removedKeys) {
      await session.recoveryBuffer.deleteFragment(removedKey);
    }
    for (const [reloadKey, content] of result.structuralChange.contentByKey) {
      await session.recoveryBuffer.writeFragment(reloadKey, content);
    }
  }

  // (4) Broadcast structural remaps to connected clients.
  if (_normalizeBroadcast && result.remaps.length > 0) {
    _normalizeBroadcast(session.docPath, [...result.remaps]);
  }
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

/** Normalization broadcast callback — set by crdt-sync.ts to send STRUCTURE_WILL_CHANGE. */
let _normalizeBroadcast: ((docPath: string, info: Array<{ oldKey: string; newKeys: string[] }>) => void) | null = null;

export function setNormalizeBroadcast(cb: (docPath: string, info: Array<{ oldKey: string; newKeys: string[] }>) => void): void {
  _normalizeBroadcast = cb;
}

/** YJS update broadcast callback — set by crdt-sync.ts to send a YJS_UPDATE to all subscribers. */
let _yjsUpdateBroadcast: ((docPath: string, update: Uint8Array) => void) | null = null;

export function setYjsUpdateBroadcast(cb: (docPath: string, update: Uint8Array) => void): void {
  _yjsUpdateBroadcast = cb;
}

/** Post-commit notify callback — emits proposal:injected_into_session Hub event after injection. */
let _postCommitNotify: ((docPath: string, proposalId: string, writerDisplayName: string, headingPaths: string[][]) => void) | null = null;

export function setPostCommitNotify(cb: (docPath: string, proposalId: string, writerDisplayName: string, headingPaths: string[][]) => void): void {
  _postCommitNotify = cb;
}

/**
 * Inject committed canonical content into the live Y.Doc for a document (if a session
 * exists) and broadcast the resulting YJS_UPDATE delta to all connected clients.
 *
 * Called via the post-commit hook in commit-pipeline.ts after absorb() and
 * transitionToCommitted() succeed.
 *
 * Safety: SectionGuard hard-blocks any focused section at evaluation time, so no
 * active Milkdown editor is mounted for the committed sections at the moment this
 * fires. However, there is a narrow async window between commit completion and this
 * injection: a user could theoretically refocus the section in that window. The
 * broadcast reconciles the client — no lock is needed, but this behaviour (user's
 * brand-new edit overwritten by the broadcast) is documented here intentionally.
 *
 * ContentLayer is lazy-imported to avoid circular dependency (matching fromDisk pattern).
 * getContentRoot() reads canonical content (not the session overlay) — this is correct
 * because we want just-committed canonical content, not any in-progress session overlay.
 *
 * Errors propagate — no try/catch.
 */
export async function injectAfterCommit(
  docPath: string,
  headingPaths: string[][],
  meta: { proposalId: string; writerDisplayName: string },
): Promise<void> {
  const session = lookupDocSession(docPath);
  if (!session) return;

  // Lazy-import to avoid circular dependency (content-layer → ydoc-lifecycle)
  const { ContentLayer } = await import("../storage/content-layer.js");
  // getContentRoot() is the canonical root — reads just-committed canonical content,
  // not the session overlay (getSessionSectionsContentRoot would read the in-progress overlay).
  const layer = new ContentLayer(getContentRoot());

  const svBefore = Y.encodeStateVector(session.ydoc);

  // Caller-owned source policy (item 345): runtime code reads canonical content,
  // builds the full FragmentContent (heading + body for non-root, body for root),
  // and delegates to the policy-free `replaceFragmentString(...)` on the live store.
  for (const headingPath of headingPaths) {
    const fragmentKey = requireKeyForHeadingPath(session, headingPath);
    // Level and heading are derivable from the heading path:
    // level = path length (0 for BFH, path.length for sections), heading = last element.
    const level = headingPath.length;
    const heading = headingPath.length > 0 ? headingPath[headingPath.length - 1] : "";
    const body = await layer.readSection(new SectionRef(docPath, headingPath));
    const content = buildFragmentContentFn(body, level, heading);
    session.liveFragments.replaceFragmentString(fragmentKey, content, SERVER_INJECTION_ORIGIN);
  }

  const update = Y.encodeStateAsUpdate(session.ydoc, svBefore);
  if (update.length > 0) {
    if (_yjsUpdateBroadcast) {
      _yjsUpdateBroadcast(docPath, update);
    }
    if (_postCommitNotify) {
      _postCommitNotify(docPath, meta.proposalId, meta.writerDisplayName, headingPaths);
    }
  }
}

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
 * raw snapshot → accept → applyAcceptResult. Used by tests and perf
 * benchmarks. Production flush is in the coordinator (adds two-tier
 * structural-cleanliness gating and WebSocket broadcast).
 */
export async function flushDirtyToOverlay(session: DocSession): Promise<void> {
  const scope = session.liveFragments.getAheadOfStagedKeys();
  if (scope.size === 0) return;
  await session.recoveryBuffer.snapshotFromLive(session.liveFragments, scope);
  const result = await session.stagedSections.acceptLiveFragments(session.liveFragments, scope);
  await applyAcceptResult(session, result);
  await persistAuthorMetadata(session);
}

/**
 * Persist per-writer dirty-state to sessions/authors/{writerId}.json so that
 * the "unpublished changes" UI survives server restarts. Written on every
 * flush — cheap (small JSON), avoids a separate timer.
 */
export async function persistAuthorMetadata(session: DocSession): Promise<void> {
  const authorsRoot = getSessionAuthorsRoot();
  await mkdir(authorsRoot, { recursive: true });
  for (const [writerId, dirtyKeys] of session.perUserDirty) {
    if (dirtyKeys.size === 0) continue;
    const dirtySections: Array<{ docPath: string; headingPath: string[]; firstChangedAt: string }> = [];
    for (const fragmentKey of dirtyKeys) {
      const hp = session.headingPathByFragmentKey.get(fragmentKey);
      if (!hp) continue;
      const ts = session.fragmentFirstActivity.get(fragmentKey);
      dirtySections.push({
        docPath: session.docPath,
        headingPath: hp,
        firstChangedAt: ts ? new Date(ts).toISOString() : new Date().toISOString(),
      });
    }
    const data = { writerId, dirtySections };
    await writeFile(path.join(authorsRoot, `${writerId}.json`), JSON.stringify(data, null, 2), "utf8");
  }
}

/**
 * Clean up author metadata after publish or session end.
 *
 * Per-docPath variant: filter out entries for the given docPath from each
 * author JSON file, deleting the file if no entries remain.
 * Blanket variant (no docPath): wipe the entire sessions/authors/ directory.
 */
export async function cleanupAuthorMetadata(docPath?: string): Promise<void> {
  const authorsRoot = getSessionAuthorsRoot();
  if (!docPath) {
    try { await rm(authorsRoot, { recursive: true, force: true }); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  let authorFiles: string[];
  try { authorFiles = await readdir(authorsRoot); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const fileName of authorFiles) {
    if (!fileName.endsWith(".json")) continue;
    const authorFilePath = path.join(authorsRoot, fileName);
    try {
      const raw = await readFile(authorFilePath, "utf8");
      const data = JSON.parse(raw) as { writerId: string; dirtySections: Array<{ docPath: string }> };
      const remaining = data.dirtySections.filter((s) => s.docPath !== docPath);
      if (remaining.length === 0) {
        await rm(authorFilePath, { force: true });
      } else if (remaining.length < data.dirtySections.length) {
        await writeFile(authorFilePath, JSON.stringify({ ...data, dirtySections: remaining }, null, 2), "utf8");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
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
 * Uses the store boundary pattern: mark ahead-of-staged → raw snapshot →
 * accept into staging → apply accept result.
 */
export async function normalizeAllFragments(session: DocSession): Promise<void> {
  // Snapshot keys upfront — normalization may mutate the key set.
  const keys = [...session.orderedFragmentKeys];
  for (const key of keys) {
    session.liveFragments.noteAheadOfStaged(key);
  }
  const scope = new Set(keys);
  await session.recoveryBuffer.snapshotFromLive(session.liveFragments, scope);
  const result = await session.stagedSections.acceptLiveFragments(session.liveFragments, scope);
  await applyAcceptResult(session, result);
}

/**
 * Normalize a specific subset of fragment keys in a session.
 * Used by scoped publish flows so unrelated sections are not touched.
 *
 * Skips keys whose entry no longer exists in the skeleton — normalization can
 * remove keys mid-loop (e.g., heading deletion merges into a sibling).
 *
 * Uses the store boundary pattern: mark ahead-of-staged → raw snapshot →
 * accept into staging → apply accept result.
 */
export async function normalizeFragmentKeys(
  session: DocSession,
  fragmentKeys: Set<string>,
): Promise<void> {
  // Filter to keys that still exist in the session index.
  const validKeys = new Set<string>();
  for (const key of fragmentKeys) {
    if (session.headingPathByFragmentKey.has(key)) {
      session.liveFragments.noteAheadOfStaged(key);
      validKeys.add(key);
    }
  }
  if (validKeys.size === 0) return;

  await session.recoveryBuffer.snapshotFromLive(session.liveFragments, validKeys);
  const result = await session.stagedSections.acceptLiveFragments(session.liveFragments, validKeys);
  await applyAcceptResult(session, result);
}

/**
 * Normalize a single fragment by key. Called on focus change (left fragment).
 *
 * Uses the store boundary pattern: mark ahead-of-staged → raw snapshot →
 * accept into staging → apply accept result.
 */
export async function normalizeFragment(docPath: string, fragmentKey: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;

  session.liveFragments.noteAheadOfStaged(fragmentKey);
  const scope = new Set([fragmentKey]);
  await session.recoveryBuffer.snapshotFromLive(session.liveFragments, scope);
  const result = await session.stagedSections.acceptLiveFragments(session.liveFragments, scope);
  await applyAcceptResult(session, result);
}

// ─── Debounced flush ─────────────────────────────────────────────

/** Tracks in-flight session-overlay import promises per session. */
const sessionOverlayImportInFlight = new WeakMap<DocSession, Promise<void>>();

/**
 * Trigger a debounced flush for a document session.
 * Resets the 1s timer on every call — flush fires 1s after the LAST edit.
 * Called from crdt-sync.ts when a YJS_UPDATE is received.
 */
export function triggerDebouncedSessionOverlayImport(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;

  // Clear previous debounce timer
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
  }

  session.flushTimer = setTimeout(() => {
    session.flushTimer = null;
    if (sessionOverlayImportInFlight.has(session)) return;
    // Skip if session is no longer "active" (e.g., released while timer was pending).
    if (session.state !== "active") return;
    // "active" → "flushing": flush I/O begins.
    session.state = "flushing";
    const promise = (async () => {
      try {
        if (_sessionOverlayImportCallback) {
          await _sessionOverlayImportCallback(session);
        }
      } finally {
        sessionOverlayImportInFlight.delete(session);
        // "flushing" → "active": flush I/O complete.
        // (Only reset if still "flushing" — releaseDocSession may have transitioned to "committing".)
        if (session.state === "flushing") {
          session.state = "active";
        }
      }
    })();
    sessionOverlayImportInFlight.set(session, promise);
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Trigger an immediate flush for a document session.
 * Cancels any pending debounce timer and flushes right away.
 * Used when the user blurs the editor — ensures content hits disk before
 * any potential page refresh.
 */
export function triggerImmediateSessionOverlayImport(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;

  // Cancel pending debounce timer — the immediate flush supersedes it.
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }

  // If a flush is already in flight, nothing more to do — the in-flight
  // flush will write the latest state.
  if (sessionOverlayImportInFlight.has(session)) return;
  if (session.state !== "active") return;

  session.state = "flushing";
  const promise = (async () => {
    try {
      if (_sessionOverlayImportCallback) {
        await _sessionOverlayImportCallback(session);
      }
    } finally {
      sessionOverlayImportInFlight.delete(session);
      if (session.state === "flushing") {
        session.state = "active";
      }
    }
  })();
  sessionOverlayImportInFlight.set(session, promise);
}

/**
 * Pause flushing for a session: cancel pending timer and await any in-flight flush.
 * Used by renameDocument to prevent flush/rename overlap.
 * Caller must call triggerDebouncedSessionOverlayImport(newPath) after rename to restart.
 */
export async function pauseSessionOverlayImport(docPath: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  const inflight = sessionOverlayImportInFlight.get(session);
  if (inflight) {
    await inflight;
  }
}

/**
 * Await any in-flight session overlay import for the given docPath without
 * canceling pending debounce timers. Used by commitDirtySections to serialize
 * publish against blur flushes — publish must not overlap acceptLiveFragments
 * or reach absorbChangedSections while a blur flush is in flight.
 */
export async function awaitPendingSessionImport(docPath: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;
  const inflight = sessionOverlayImportInFlight.get(session);
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
  session.idleTimeoutTimer = setTimeout(() => {
    // Skip if session is already tearing down — don't interfere with commit pipeline.
    if (session.state === "committing" || session.state === "ended") return;
    // Reschedule if flush is in-flight — don't force-close while flushing.
    if (session.state === "flushing") {
      resetIdleTimeout(session);
      return;
    }
    // Assert "active" — any other state here is unexpected.
    assertState(session, ["active"]);
    if (_onIdleTimeout) {
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
    for (const key of normalizeScope) {
      session.liveFragments.noteAheadOfStaged(key);
    }
    if (normalizeScope.size > 0) {
      await session.recoveryBuffer.snapshotFromLive(session.liveFragments, normalizeScope);
      const result = await session.stagedSections.acceptLiveFragments(session.liveFragments, normalizeScope);
      await applyAcceptResult(session, result);
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

  // Check in-memory session first
  const session = sessions.get(docPath);
  if (session) {
    const targetFragmentKey = findKeyForHeadingPath(session, headingPath);
    if (targetFragmentKey) {
      const fragmentTime = session.fragmentLastActivity.get(targetFragmentKey);
      if (fragmentTime != null) {
        return fragmentTime;
      }
    }
    return null;
  }

  // No in-memory session — check disk file mtime from the effective
  // overlay+canonical view so sparse session overlays still resolve.
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

// ─── Restore invalidation ─────────────────────────────────────────

/**
 * Return the pending restore notification for a writer reconnecting to docPath.
 * Returns null if no notification exists or if it has expired.
 * Does NOT consume the entry — multiple reconnecting clients must each receive it.
 */
export function getPendingRestoreNotification(
  docPath: string,
  writerId: string,
): RestoreNotificationPayload | null {
  const entry = pendingRestoreNotifications.get(docPath);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pendingRestoreNotifications.delete(docPath);
    return null;
  }
  const writerData = entry.affectedWriters.get(writerId);
  return {
    restored_sha: entry.restoreSha,
    restored_by_display_name: entry.restoredByDisplayName,
    pre_commit_sha: writerData?.preCommitSha ?? null,
    your_dirty_heading_paths: writerData?.dirtyHeadingPaths ?? null,
  };
}

/**
 * Invalidate the live session for a document being restored.
 *
 * Steps:
 *   1. Store the pending restore notification (before closing sockets, so it is
 *      available the instant clients begin reconnecting).
 *   2. Broadcast close code 4022 to all connected sockets (via callback).
 *   3. Destroy the live session synchronously — data was already committed by
 *      the inline pre-commit at the call site; no further import/commit is needed.
 */
export async function invalidateSessionForRestore(
  docPath: string,
  restoreSha: string,
  restoredByDisplayName: string,
  preCommitResult: PreemptiveCommitResult | null,
): Promise<void> {
  // Build and store the pending notification FIRST.
  const affectedWriters = new Map<string, { preCommitSha: string; dirtyHeadingPaths: string[][] }>();
  if (preCommitResult) {
    for (const { writerId, dirtyHeadingPaths } of preCommitResult.affectedWriters) {
      affectedWriters.set(writerId, {
        preCommitSha: preCommitResult.committedSha,
        dirtyHeadingPaths,
      });
    }
  }
  pendingRestoreNotifications.set(docPath, {
    restoreSha,
    restoredByDisplayName,
    affectedWriters,
    expiresAt: Date.now() + RESTORE_NOTIFICATION_TTL_MS,
  });

  // Close all connected sockets with code 4022 (non-blocking).
  if (_broadcastRestoreInvalidation) {
    _broadcastRestoreInvalidation(docPath);
  }

  // Destroy the live session — all dirty data was committed in preemptiveImportNormalizeAndCommit.
  const session = sessions.get(docPath);
  if (session) {
    assertState(session, ["active", "flushing"]);
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.idleTimeoutTimer) {
      clearTimeout(session.idleTimeoutTimer);
      session.idleTimeoutTimer = null;
    }
    const { teardownSessionStores } = await import("../storage/restore-teardown.js");
    await teardownSessionStores(session.liveFragments, session.stagedSections, session.recoveryBuffer);
    session.state = "ended";
    sessions.delete(docPath);
    sessionPromises.delete(docPath);
  }
}