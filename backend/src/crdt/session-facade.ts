/**
 * SessionFacade — high-level API wrapping DocSession + FragmentStore + PresenceManager.
 *
 * Provides atomic compound operations so the coordinator can remain a message router
 * (decode binary → call facade → encode response/broadcast) without reaching into
 * session internals.
 */

import * as Y from "yjs";
import type { DocSession } from "./ydoc-lifecycle.js";
import { FragmentStore } from "./fragment-store.js";
import {
  markFragmentDirty,
  updateSectionFocus,
  updateActivity,
  updateEditPulse,
  addContributor,
  triggerDebouncedFlush,
  triggerImmediateFlush,
  normalizeFragment,
} from "./ydoc-lifecycle.js";
import { fragmentFromRemark } from "../storage/section-formatting.js";
import { fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import type { WriterIdentity } from "../types/shared.js";

// ─── Facade ──────────────────────────────────────────────

export class SessionFacade {
  constructor(private readonly session: DocSession) {}

  // ── Queries ─────────────────────────────────────────────

  get docPath(): string {
    return this.session.docPath;
  }

  get docSessionId(): string {
    return this.session.docSessionId;
  }

  get baseHead(): string {
    return this.session.baseHead;
  }

  get ydoc(): Y.Doc {
    return this.session.fragments.ydoc;
  }

  isDirty(): boolean {
    return this.session.fragments.dirtyKeys.size > 0;
  }

  getHolderCount(): number {
    return this.session.holders.size;
  }

  getFragmentKeys(): string[] {
    const keys: string[] = [];
    this.session.fragments.skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
      const isBfh = FragmentStore.isBeforeFirstHeading({ headingPath, level: _level, heading: _heading });
      keys.push(fragmentKeyFromSectionFile(sectionFile, isBfh));
    });
    return keys;
  }

  // ── Commands ────────────────────────────────────────────

  /**
   * Apply a Y.Doc update and track dirty fragments for the writer.
   * Atomic: Y.Doc update + dirtyKeys + perUserDirty in one call.
   *
   * Returns the focused path (if any) for broadcasting presence events,
   * and the list of newly-dirtied fragment keys for dirty:changed events.
   */
  applyUpdate(
    payload: Uint8Array,
    writerId: string,
  ): { newlyDirtyKeys: Array<{ fragmentKey: string; headingPath: string[] }>; touchedKeys: string[] } {
    const session = this.session;
    Y.applyUpdate(session.fragments.ydoc, payload);
    updateActivity(session.docPath);

    const newlyDirtyKeys: Array<{ fragmentKey: string; headingPath: string[] }> = [];
    const touchedKeys: string[] = [];

    // Track which fragment this writer dirtied
    const focusedPath = session.presenceManager.getAll().get(writerId);
    if (focusedPath !== undefined) {
      const entry = session.fragments.skeleton.expect(focusedPath);
      const fragmentKey = FragmentStore.fragmentKeyFor(entry);
      session.fragments.markDirty(fragmentKey);
      const isNewlyDirty = markFragmentDirty(session.docPath, writerId, fragmentKey);
      if (isNewlyDirty) {
        newlyDirtyKeys.push({ fragmentKey, headingPath: focusedPath });
      }
      touchedKeys.push(fragmentKey);
    } else {
      // No focus — mark only the fragments actually touched by this transaction
      for (const fragmentKey of session.lastTouchedFragments) {
        session.fragments.markDirty(fragmentKey);
        markFragmentDirty(session.docPath, writerId, fragmentKey);
        touchedKeys.push(fragmentKey);
      }
      session.lastTouchedFragments.clear();
    }

    triggerDebouncedFlush(session.docPath);
    return { newlyDirtyKeys, touchedKeys };
  }

  /**
   * Update section focus for a writer. Returns old focus info for
   * presence event broadcasting and normalization.
   */
  async setFocus(
    writerId: string,
    headingPath: string[],
  ): Promise<{ oldFocus: string[] | null; oldFragmentKey: string | null }> {
    const session = this.session;
    const { oldFocus } = updateSectionFocus(session.docPath, writerId, headingPath);

    let oldFragmentKey: string | null = null;
    if (oldFocus) {
      const oldEntry = session.fragments.skeleton.find(oldFocus);
      if (oldEntry) {
        oldFragmentKey = FragmentStore.fragmentKeyFor(oldEntry);
        await normalizeFragment(session.docPath, oldFragmentKey);
      }
    }

    return { oldFocus, oldFragmentKey };
  }

  /**
   * Mutate a section's content via fragment key + markdown.
   * Returns the Y.Doc update delta for broadcasting.
   */
  mutateSection(
    fragmentKey: string,
    markdown: string,
    writerId: string,
  ): { update: Uint8Array; error?: string } {
    const session = this.session;
    const entry = session.fragments.resolveEntryForKey(fragmentKey);
    if (!entry) {
      return { update: new Uint8Array(), error: `Fragment key not found: ${fragmentKey}` };
    }

    const svBefore = Y.encodeStateVector(session.fragments.ydoc);
    session.fragments.setFragmentContent(fragmentKey, fragmentFromRemark(markdown));
    session.fragments.markDirty(fragmentKey);
    markFragmentDirty(session.docPath, writerId, fragmentKey);

    const update = Y.encodeStateAsUpdate(session.fragments.ydoc, svBefore);
    triggerDebouncedFlush(session.docPath);
    return { update };
  }

  /** Trigger an immediate flush to disk. */
  flush(): void {
    triggerImmediateFlush(this.session.docPath);
  }

  /** Record an activity pulse from a writer. */
  recordActivityPulse(writerId: string, identity: WriterIdentity): void {
    updateEditPulse(this.session.docPath, writerId);
    addContributor(this.session.docPath, writerId, identity);
  }

  /** Encode SYNC_STEP_2 response to a client's SYNC_STEP_1. */
  encodeSyncResponse(clientStateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.session.fragments.ydoc, clientStateVector);
  }
}

// ─── Factory ─────────────────────────────────────────────

export function facadeFor(session: DocSession): SessionFacade {
  return new SessionFacade(session);
}
