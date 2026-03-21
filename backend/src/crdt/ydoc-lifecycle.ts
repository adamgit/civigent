/**
 * Y.Doc Lifecycle — Session acquire/release/destroy, holders, timers.
 *
 * One Y.Doc per document. Session lifecycle:
 *   - Created when first writer connects to a document
 *   - Destroyed when last holder disconnects (after flush to disk)
 *   - Survives mid-session commits (baseHead updated)
 *   - Reconstructed from canonical + sessions/docs/ overlay on reconnect
 */

import path from "node:path";
import { getSessionDocsRoot } from "../storage/data-root.js";
import type { WriterIdentity } from "../types/shared.js";
import { FragmentStore } from "./fragment-store.js";
import { fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import { SectionRef } from "../domain/section-ref.js";

// ─── DocSession interface ────────────────────────────────────────

export interface DocSession {
  fragments: FragmentStore;                // Y.Doc + skeleton paired together
  docPath: string;
  holders: Map<string, WriterIdentity>;     // Connected writer IDs → identity
  sectionFocus: Map<string, string[]>;     // editingPresence: writerId → headingPath they're currently editing
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
  /** Fragment keys touched by the most recent Y.Doc transaction(s).
   *  Populated by an afterTransaction listener, consumed by the no-focus
   *  dirty-tracking path in crdt-sync.ts, then cleared. */
  lastTouchedFragments: Set<string>;
}

// ─── Module state ────────────────────────────────────────────────

const sessions = new Map<string, DocSession>();

const IDLE_TIMEOUT_MS = 60_000;
const FLUSH_DEBOUNCE_MS = 1_000;

// ─── Lookup ──────────────────────────────────────────────────────

export function lookupDocSession(docPath: string): DocSession | undefined {
  return sessions.get(docPath);
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

export interface FlushCallback {
  (session: DocSession): Promise<void>;
}

let _flushCallback: FlushCallback | null = null;

export function setFlushCallback(cb: FlushCallback): void {
  _flushCallback = cb;
}

export async function acquireDocSession(
  docPath: string,
  writerId: string,
  baseHead: string,
  writerIdentity?: WriterIdentity,
): Promise<DocSession> {
  const identity = writerIdentity ?? { id: writerId, type: "human" as const, displayName: writerId };

  // Case 1: Session already exists in memory
  let session = sessions.get(docPath);
  if (session) {
    session.holders.set(writerId, identity);
    session.lastActivityAt = Date.now();
    resetIdleTimeout(session);
    return session;
  }

  // Case 2 or 3: Build FragmentStore from disk (session overlay or canonical)
  const { store: fragments, orphanedBodies } = await FragmentStore.fromDisk(docPath);
  if (orphanedBodies.length > 0) {
    // Append a "Recovered edits" section so the user can review orphaned content
    const { buildRecoverySectionMarkdown } = await import("../storage/crash-recovery.js");
    const recoveryBody = buildRecoverySectionMarkdown(orphanedBodies);
    const recoverySection = { heading: "Recovered edits", level: 2, body: recoveryBody, headingPath: ["Recovered edits"] };
    const addedEntries = fragments.skeleton.addSectionsFromRootSplit([recoverySection]);
    for (const addedEntry of addedEntries) {
      if (addedEntry.isSubSkeleton) continue;
      const isRoot = FragmentStore.isDocumentRoot(addedEntry);
      const newKey = fragmentKeyFromSectionFile(addedEntry.sectionFile, isRoot);
      const headingLine = `${"#".repeat(addedEntry.level)} ${addedEntry.heading}`;
      const fragmentContent = recoveryBody.trim()
        ? `${headingLine}\n\n${recoveryBody}`
        : headingLine;
      fragments.populateFragment(newKey, fragmentContent);
    }
    if (fragments.skeleton.dirty) {
      await fragments.skeleton.persist();
    }
  }

  const touchedSet = new Set<string>();

  // Build a reverse lookup: AbstractType → fragment key name.
  // Updated lazily when share map grows (new fragments added by normalization).
  let reverseMap = new Map<object, string>();
  let lastShareSize = 0;

  function rebuildReverseMap(): void {
    reverseMap = new Map();
    for (const [name, shared] of fragments.ydoc.share) {
      reverseMap.set(shared, name);
    }
    lastShareSize = fragments.ydoc.share.size;
  }

  // Register afterTransaction listener to track which fragments were modified.
  // This avoids the O(N) mark-all-dirty cascade when no focus is set.
  fragments.ydoc.on("afterTransaction", (txn: import("yjs").Transaction) => {
    if (fragments.ydoc.share.size !== lastShareSize) rebuildReverseMap();
    for (const [type] of txn.changed) {
      // Walk up to the root shared type
      let current: any = type;
      while (current._item?.parent) current = current._item.parent;
      const name = reverseMap.get(current);
      if (name) touchedSet.add(name);
    }
  });

  session = {
    fragments,
    docPath,
    holders: new Map([[writerId, identity]]),
    sectionFocus: new Map(),
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
    lastTouchedFragments: touchedSet,
  };

  sessions.set(docPath, session);
  resetIdleTimeout(session);

  return session;
}

export interface ReleaseResult {
  sessionEnded: boolean;
}

export async function releaseDocSession(
  docPath: string,
  writerId: string,
): Promise<ReleaseResult> {
  const session = sessions.get(docPath);
  if (!session) return { sessionEnded: false };

  session.holders.delete(writerId);
  session.sectionFocus.delete(writerId);

  if (session.holders.size === 0) {
    // Cancel pending debounce
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }

    // Flush to disk before destroying
    if (_flushCallback) {
      await _flushCallback(session);
    }

    try {
      // Normalize any fragments with embedded headings
      await normalizeAllFragments(session);
    } finally {
      // Always clean up timers and destroy Y.Doc, even if normalization fails
      if (session.idleTimeoutTimer) {
        clearTimeout(session.idleTimeoutTimer);
      }

      session.fragments.ydoc.destroy();
      sessions.delete(docPath);
    }

    return { sessionEnded: true };
  }

  return { sessionEnded: false };
}

// ─── Section Focus (editingPresence) ─────────────────────────────
// editingPresence: server-authoritative, drives agent blocking and
// human-involvement scoring. Never derived from Awareness CRDT.

export function updateSectionFocus(
  docPath: string,
  writerId: string,
  headingPath: string[],
): { oldFocus: string[] | undefined } {
  const session = sessions.get(docPath);
  if (!session) return { oldFocus: undefined };

  const oldFocus = session.sectionFocus.get(writerId);
  // editingPresence: record which section this writer is focused on
  session.sectionFocus.set(writerId, headingPath);
  session.lastActivityAt = Date.now();
  session.lastWriterId = writerId;
  // Note: section focus alone no longer resets idle timeout.
  // Only ACTIVITY_PULSE resets it (the user must actually be typing).

  return { oldFocus };
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

/**
 * Normalize all fragments in a session that have embedded headings.
 * Called on disconnect (after flush) and shutdown.
 */
async function normalizeAllFragments(session: DocSession): Promise<void> {
  const fragments = session.fragments;

  // Collect fragment keys first (normalization may mutate the skeleton)
  const keys: string[] = [];
  fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    const isRoot = FragmentStore.isDocumentRoot({ headingPath, level, heading });
    keys.push(fragmentKeyFromSectionFile(sectionFile, isRoot));
  });

  for (const fragmentKey of keys) {
    const broadcastOpts = _normalizeBroadcast
      ? { broadcastStructureChange: (info: Array<{ oldKey: string; newKeys: string[] }>) => _normalizeBroadcast!(session.docPath, info) }
      : undefined;
    await fragments.normalizeStructure(fragmentKey, broadcastOpts);
  }
}

/**
 * Normalize a single fragment by key. Called on focus change (left fragment).
 */
export async function normalizeFragment(docPath: string, fragmentKey: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;

  const broadcastOpts = _normalizeBroadcast
    ? { broadcastStructureChange: (info: Array<{ oldKey: string; newKeys: string[] }>) => _normalizeBroadcast!(docPath, info) }
    : undefined;
  await session.fragments.normalizeStructure(fragmentKey, broadcastOpts);
}

// ─── Debounced flush ─────────────────────────────────────────────

/** Tracks in-flight flush promises per session. */
const flushInFlight = new WeakMap<DocSession, Promise<void>>();

/**
 * Trigger a debounced flush for a document session.
 * Resets the 1s timer on every call — flush fires 1s after the LAST edit.
 * Called from crdt-sync.ts when a YJS_UPDATE is received.
 */
export function triggerDebouncedFlush(docPath: string): void {
  const session = sessions.get(docPath);
  if (!session) return;

  // Clear previous debounce timer
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
  }

  session.flushTimer = setTimeout(() => {
    session.flushTimer = null;
    if (flushInFlight.has(session)) return;
    const promise = (async () => {
      try {
        if (_flushCallback) {
          await _flushCallback(session);
        }
      } finally {
        flushInFlight.delete(session);
      }
    })();
    flushInFlight.set(session, promise);
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Pause flushing for a session: cancel pending timer and await any in-flight flush.
 * Used by renameDocument to prevent flush/rename overlap.
 * Caller must call triggerDebouncedFlush(newPath) after rename to restart.
 */
export async function pauseFlush(docPath: string): Promise<void> {
  const session = sessions.get(docPath);
  if (!session) return;
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
  const inflight = flushInFlight.get(session);
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
  for (const [writerId, focusedPath] of session.sectionFocus.entries()) {
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
    session.fragments.ydoc.destroy();
  }
  sessions.clear();
}

/**
 * Flush all active sessions and destroy them. Used at shutdown.
 */
export async function flushAndDestroyAll(): Promise<void> {
  for (const session of sessions.values()) {
    // Cancel pending debounce — we flush immediately
    if (session.flushTimer) clearTimeout(session.flushTimer);
    if (_flushCallback) {
      await _flushCallback(session);
    }
    // Normalize after flush, before destroy
    await normalizeAllFragments(session);
    if (session.idleTimeoutTimer) clearTimeout(session.idleTimeoutTimer);
    session.fragments.ydoc.destroy();
  }
  sessions.clear();
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
    const entry = session.fragments.skeleton.resolveByHeadingPath(headingPath);
    if (entry) {
      const targetFragmentKey = fragmentKeyFromSectionFile(entry.sectionFile, headingPath.length === 0);
      const fragmentTime = session.fragmentLastActivity.get(targetFragmentKey);
      if (fragmentTime != null) {
        return fragmentTime;
      }
    }
    return null;
  }

  // No in-memory session — check disk file mtime for orphaned sessions
  const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
  if (headingPath.length === 0) return null;

  try {
    const { resolveHeadingPathUnderRoot } = await import("../storage/heading-resolver.js");
    const filePath = await resolveHeadingPathUnderRoot(sessionDocsContentRoot, docPath, headingPath);
    const { stat } = await import("node:fs/promises");
    const stats = await stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}