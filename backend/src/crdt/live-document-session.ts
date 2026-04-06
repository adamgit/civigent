import * as Y from "yjs";
import { fragmentFromRemark } from "../storage/section-formatting.js";
import type { ModeTransitionResult, WsServerEvent, WriterIdentity } from "../types/shared.js";
import { FragmentStore } from "./fragment-store.js";
import { FragmentNormalizer } from "./fragment-normalizer.js";
import type { DocSession } from "./ydoc-lifecycle.js";
import {
  addContributor,
  markFragmentDirty,
  triggerDebouncedFlush,
  triggerImmediateFlush,
  updateActivity,
  updateEditPulse,
  updateSectionFocus,
} from "./ydoc-lifecycle.js";

export interface SessionSocketMessage {
  audience: "caller" | "others" | "all";
  payload: Uint8Array;
}

export interface SessionDirtyChange {
  writerId: string;
  fragmentKey: string;
  headingPath: string[];
  dirty: boolean;
}

export interface SessionCommandResult {
  modeResult?: ModeTransitionResult;
  socketMessages?: SessionSocketMessage[];
  hubEvents?: WsServerEvent[];
  closeSockets?: Array<{ role?: "observer" | "editor"; code: number; reason: string }>;
  dirtyChanges?: SessionDirtyChange[];
  committed?: {
    commitSha: string;
    sections: Array<{ doc_path: string; heading_path: string[] }>;
    contributorIds: string[];
  };
  error?: string;
}

export interface SessionJoinSnapshot {
  fullUpdate: Uint8Array;
  stateVector: Uint8Array;
  presence: Array<{ writerId: string; headingPath: string[]; identity: WriterIdentity }>;
}

/**
 * LiveDocumentSession is the command boundary for one active DocSession.
 * It centralizes runtime sequencing while reusing existing lifecycle/storage code.
 */
export class LiveDocumentSession {
  private readonly normalizer = new FragmentNormalizer();

  constructor(private readonly session: DocSession) {}

  get docPath(): string {
    return this.session.docPath;
  }

  get docSessionId(): string {
    return this.session.docSessionId;
  }

  get baseHead(): string {
    return this.session.baseHead;
  }

  get doc(): Y.Doc {
    return this.session.fragments.ydoc;
  }

  get raw(): DocSession {
    return this.session;
  }

  applyYjsUpdate(writerId: string, payload: Uint8Array): SessionCommandResult {
    Y.applyUpdate(this.session.fragments.ydoc, payload);
    updateActivity(this.session.docPath);

    const dirtyChanges: SessionDirtyChange[] = [];
    const focusedPath = this.session.presenceManager.getAll().get(writerId);
    if (focusedPath !== undefined) {
      const entry = this.session.fragments.skeleton.expect(focusedPath);
      const fragmentKey = FragmentStore.fragmentKeyFor(entry);
      this.session.fragments.markDirty(fragmentKey);
      const isNewlyDirty = markFragmentDirty(this.session.docPath, writerId, fragmentKey);
      if (isNewlyDirty) {
        dirtyChanges.push({ writerId, fragmentKey, headingPath: focusedPath, dirty: true });
      }
    } else {
      for (const fragmentKey of this.session.lastTouchedFragments) {
        this.session.fragments.markDirty(fragmentKey);
        markFragmentDirty(this.session.docPath, writerId, fragmentKey);
      }
      this.session.lastTouchedFragments.clear();
    }

    triggerDebouncedFlush(this.session.docPath);
    return {
      socketMessages: [{ audience: "others", payload }],
      dirtyChanges,
    };
  }

  async setFocus(writerId: string, headingPath: string[], identity: WriterIdentity): Promise<SessionCommandResult> {
    const { oldFocus } = updateSectionFocus(this.session.docPath, writerId, headingPath);

    if (oldFocus) {
      const oldEntry = this.session.fragments.skeleton.find(oldFocus);
      if (oldEntry) {
        const oldFragmentKey = FragmentStore.fragmentKeyFor(oldEntry);
        await this.normalizer.normalize(oldFragmentKey, this.session.fragments, {
          broadcastStructureChange: undefined,
        });
      }
    }

    const hubEvents: WsServerEvent[] = [];
    if (oldFocus) {
      hubEvents.push({
        type: "presence:done",
        writer_id: writerId,
        writer_display_name: identity.displayName,
        writer_type: identity.type,
        doc_path: this.session.docPath,
        heading_path: oldFocus,
      });
    }

    hubEvents.push({
      type: "presence:editing",
      doc_path: this.session.docPath,
      writer_id: writerId,
      writer_display_name: identity.displayName,
      writer_type: identity.type,
      heading_path: headingPath,
    });

    return { hubEvents };
  }

  mutateSection(writerId: string, fragmentKey: string, markdown: string): SessionCommandResult {
    const entry = this.session.fragments.resolveEntryForKey(fragmentKey);
    if (!entry) {
      return { error: `Fragment key not found: ${fragmentKey}` };
    }

    const svBefore = Y.encodeStateVector(this.session.fragments.ydoc);
    this.session.fragments.setFragmentContent(fragmentKey, fragmentFromRemark(markdown));
    this.session.fragments.markDirty(fragmentKey);
    markFragmentDirty(this.session.docPath, writerId, fragmentKey);

    const update = Y.encodeStateAsUpdate(this.session.fragments.ydoc, svBefore);
    triggerDebouncedFlush(this.session.docPath);

    return {
      socketMessages: update.length > 0 ? [{ audience: "others", payload: update }] : [],
      dirtyChanges: [{ writerId, fragmentKey, headingPath: entry.headingPath, dirty: true }],
    };
  }

  recordActivityPulse(writerId: string, identity: WriterIdentity): SessionCommandResult {
    updateEditPulse(this.session.docPath, writerId);
    addContributor(this.session.docPath, writerId, identity);
    return {};
  }

  flushNow(): SessionCommandResult {
    triggerImmediateFlush(this.session.docPath);
    return {};
  }

  buildJoinSnapshot(): SessionJoinSnapshot {
    const presence: SessionJoinSnapshot["presence"] = [];
    for (const [writerId, headingPath] of this.session.presenceManager.getAll()) {
      const holder = this.session.holders.get(writerId);
      if (!holder) continue;
      presence.push({ writerId, headingPath, identity: holder.identity });
    }

    return {
      fullUpdate: Y.encodeStateAsUpdate(this.session.fragments.ydoc),
      stateVector: Y.encodeStateVector(this.session.fragments.ydoc),
      presence,
    };
  }
}

