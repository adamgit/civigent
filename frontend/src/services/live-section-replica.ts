import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { fragmentToMarkdown } from "./fragment-to-markdown";
import { SectionId, type LiveSectionRef } from "../types/live-sections";
import type { WireLiveSectionsState, PublishTriggerDecision } from "../types/shared";

/** Yjs transaction origin stamped on every server-delivered apply (bootstrap
 *  and update frames). Lets transport-level waiters (e.g. the live-move caret
 *  restore) recognize server fan-out on the shared doc without the provider
 *  ever applying content itself. */
export const LIVE_SECTION_SERVER_APPLY_ORIGIN: unique symbol = Symbol("live-section-server-apply");

declare const LiveEditorBindingBrand: unique symbol;

export interface LiveEditorBinding {
  readonly [LiveEditorBindingBrand]: "LiveEditorBinding";
}

/** One section a bound proposal has claimed — its heading path (always) and, when
 *  the claim still maps into the current live topology, its fragment key. */
export interface ClaimedSection {
  readonly headingPath: readonly string[];
  readonly fragmentKey?: string;
}

export interface LiveEditorAttachFields {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly fragmentKey: string;
}

export function unwrapLiveEditorBindingForMilkdown(binding: LiveEditorBinding): LiveEditorAttachFields {
  return binding as unknown as LiveEditorAttachFields;
}

export interface LiveSectionHandle {
  readonly id: SectionId;
  readMarkdown(): string;
  isEditable(): boolean;
  createEditorBinding(): LiveEditorBinding;
}

/**
 * The full public replica contract. Lifecycle:
 *
 *   unbound → bound+currently-live → bound+invalidated → mint a new replica
 *
 * One replica holds exactly one DocSession Y.Doc history. After session end
 * the object is permanently invalid for any other session id.
 */
export interface LiveSectionReplica {
  /** DocSession whose Y.Doc history this replica holds. Set by
   *  `bindToDocSession`; never changes; survives invalidation. null until
   *  first bind. */
  readonly boundDocSessionId: string | null;
  /** True only while this bound replica may be used as live display/edit authority. */
  readonly isCurrentlyLiveAuthority: boolean;

  subscribe(listener: () => void): () => void;
  getTopology(): readonly LiveSectionRef[];
  /** Topology membership only — safe before live authority; never implies
   *  editable/live paint. The only soft-miss section accessor. */
  findInTopology(sectionId: SectionId): LiveSectionHandle | undefined;
  /** Throws unless currently live authority, id is in topology, and the
   *  fragment exists. Never returns undefined. */
  getLiveSection(sectionId: SectionId): LiveSectionHandle;
  isPending(sectionId: SectionId): boolean;
  /** True when the server marked this section blocked (lock/contention). */
  isBlocked(sectionId: SectionId): boolean;
  /** Fragment keys with uncommitted (pending) live edits, for save-status. */
  getPendingSectionKeys(): readonly string[];
  /** True while the join-mirror or a live pause has editors frozen. */
  isPublishPauseMirrorActive(): boolean;
  clearPublishPauseMirror(): void;
  /** Latest publish-trigger decision for the doc (the evaluator's output), or null if none received. */
  getPublishDecision(): PublishTriggerDecision | null;
  /** The `inprogress` proposal bound to this live document, or null when none is bound. */
  getBoundProposalId(): string | null;
  /** The bound proposal's claimed sections for this doc — the manifest set finalization publishes. */
  getClaimedSections(): readonly ClaimedSection[];
  /** Changed-section count = size of the bound proposal's claim set. */
  getChangedSectionCount(): number;
  /**
   * Fragment keys of sections actively being edited right now — the deduped UNION
   * of pending-writer sections and attached-editor focus sections (FP7).
   */
  getActivelyEditedSectionKeys(): readonly string[];
  /** Observer/editor UI write switch (not auth). */
  setEditingEnabled(enabled: boolean): void;

  /** Only legal when `boundDocSessionId === null`. Binds permanently and
   *  becomes currently live. */
  bindToDocSession(bootstrap: LiveBootstrapInput): void;
  /** Only legal when `bootstrap.docSessionId === boundDocSessionId`.
   *  Same-session reconnect. */
  mergeSameSessionBootstrap(bootstrap: LiveBootstrapInput): void;
  /** Ingest a live-sections update frame (yjs and/or state). Does not grant
   *  live authority. */
  ingestUpdate(input: LiveUpdateInput): void;
  destroy(): void;
}

export interface LiveBootstrapInput {
  docSessionId: string;
  state: WireLiveSectionsState;
  yjsUpdate: Uint8Array;
}

export interface LiveUpdateInput {
  yjsUpdate?: Uint8Array;
  state?: WireLiveSectionsState;
}

class LiveSectionReplicaImpl implements LiveSectionReplica {
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  private readonly origin: symbol = LIVE_SECTION_SERVER_APPLY_ORIGIN;

  private currentlyLiveAuthority = false;
  private editingEnabled = false;
  private _boundDocSessionId: string | null = null;

  private topology: readonly LiveSectionRef[] = [];
  private topologyIds = new Set<SectionId>();
  private blocked = new Set<SectionId>();
  private pending = new Map<SectionId, { writerId: string; writerDisplayName: string }>();
  private editorsFrozenByPauseMirror = false;
  private publishDecision: PublishTriggerDecision | null = null;
  private _boundProposalId: string | null = null;
  private _claimedSections: readonly ClaimedSection[] = [];
  private _editorFocusSectionIds: readonly string[] = [];

  private readonly listeners = new Set<() => void>();
  private destroyed = false;
  /** Per-fragment markdown, invalidated when that fragment's Y types change. */
  private readonly markdownCache = new Map<string, string>();
  private readonly shareByType = new Map<Y.AbstractType<Y.YEvent<any>>, string>();
  private lastShareSize = -1;
  private readonly invalidateCachedMarkdown = (txn: Y.Transaction): void => {
    if (this.destroyed) return;
    if (this.doc.share.size !== this.lastShareSize) {
      this.shareByType.clear();
      for (const [name, shared] of this.doc.share) {
        this.shareByType.set(shared, name);
      }
      this.lastShareSize = this.doc.share.size;
    }
    for (const [type] of txn.changed) {
      let current: Y.AbstractType<Y.YEvent<any>> | null = type;
      while (current?._item?.parent) {
        current = current._item.parent as Y.AbstractType<Y.YEvent<any>>;
      }
      if (!current) continue;
      const name = this.shareByType.get(current);
      if (name) this.markdownCache.delete(name);
    }
  };

  constructor(doc?: Y.Doc, awareness?: Awareness) {
    this.doc = doc ?? new Y.Doc();
    this.awareness = awareness ?? new Awareness(this.doc);
    this.doc.on("afterTransaction", this.invalidateCachedMarkdown);
  }

  get isCurrentlyLiveAuthority(): boolean {
    return this.currentlyLiveAuthority;
  }

  get boundDocSessionId(): string | null {
    return this._boundDocSessionId;
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.destroyed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getTopology(): readonly LiveSectionRef[] {
    return this.topology;
  }

  findInTopology(sectionId: SectionId): LiveSectionHandle | undefined {
    if (!this.topologyIds.has(sectionId)) return undefined;
    return this.makeHandle(sectionId);
  }

  getLiveSection(sectionId: SectionId): LiveSectionHandle {
    if (!this.currentlyLiveAuthority) {
      throw new Error(
        "LiveSectionReplica.getLiveSection called while not currently live authority.",
      );
    }
    if (!this.topologyIds.has(sectionId)) {
      throw new Error(
        `getLiveSection: section "${SectionId.text(sectionId)}" is not in the live topology.`,
      );
    }
    if (!this.doc.share.has(SectionId.text(sectionId))) {
      throw new Error(
        `LiveSectionReplica invariant: topology id "${SectionId.text(sectionId)}" has no fragment in the shared doc.`,
      );
    }
    return this.makeHandle(sectionId);
  }

  isPending(sectionId: SectionId): boolean {
    return this.topologyIds.has(sectionId) && this.pending.has(sectionId);
  }

  isBlocked(sectionId: SectionId): boolean {
    return this.topologyIds.has(sectionId) && this.blocked.has(sectionId);
  }

  getPendingSectionKeys(): readonly string[] {
    return [...this.pending.keys()]
      .filter((id) => this.topologyIds.has(id))
      .map((id) => SectionId.text(id));
  }

  getPublishDecision(): PublishTriggerDecision | null {
    return this.publishDecision;
  }

  getBoundProposalId(): string | null {
    return this._boundProposalId;
  }

  getClaimedSections(): readonly ClaimedSection[] {
    return this._claimedSections;
  }

  getChangedSectionCount(): number {
    return this._claimedSections.length;
  }

  getActivelyEditedSectionKeys(): readonly string[] {
    // Union of pending-writer sections and attached-editor focus sections,
    // deduped and filtered to fragments still in the topology (FP7).
    const keys = new Set<string>();
    for (const id of this.pending.keys()) {
      if (this.topologyIds.has(id)) keys.add(SectionId.text(id));
    }
    for (const fk of this._editorFocusSectionIds) {
      if (this.topologyIds.has(SectionId.brand(fk))) keys.add(fk);
    }
    return [...keys];
  }

  isPublishPauseMirrorActive(): boolean {
    return this.editorsFrozenByPauseMirror;
  }

  clearPublishPauseMirror(): void {
    if (!this.editorsFrozenByPauseMirror) return;
    this.editorsFrozenByPauseMirror = false;
    this.notify();
  }

  setEditingEnabled(enabled: boolean): void {
    if (this.editingEnabled === enabled) return;
    this.editingEnabled = enabled;
    this.notify();
  }

  bindToDocSession(bootstrap: LiveBootstrapInput): void {
    if (this.destroyed) return;
    if (this._boundDocSessionId !== null) {
      throw new Error(
        `LiveSectionReplica.bindToDocSession: already bound (to "${this._boundDocSessionId}").`,
      );
    }
    this._boundDocSessionId = bootstrap.docSessionId;
    this.adoptBootstrap(bootstrap);
  }

  mergeSameSessionBootstrap(bootstrap: LiveBootstrapInput): void {
    if (this.destroyed) return;
    if (this._boundDocSessionId === null) {
      throw new Error("LiveSectionReplica.mergeSameSessionBootstrap: not bound.");
    }
    if (this._boundDocSessionId !== bootstrap.docSessionId) {
      throw new Error(
        `LiveSectionReplica.mergeSameSessionBootstrap: session mismatch (bound to "${this._boundDocSessionId}", got "${bootstrap.docSessionId}").`,
      );
    }
    this.adoptBootstrap(bootstrap);
  }

  ingestUpdate(input: LiveUpdateInput): void {
    if (this.destroyed) return;
    let yjsChanged = false;
    if (input.yjsUpdate) {
      const before = Y.encodeStateVector(this.doc);
      Y.applyUpdate(this.doc, input.yjsUpdate, this.origin);
      yjsChanged = !stateVectorsEqual(before, Y.encodeStateVector(this.doc));
    }
    if (input.state) this.adoptState(input.state);
    // Content-only echoes of our own keystrokes are already in the doc (y-prosemirror
    // wrote them). Applying them is a no-op; notifying would re-render every
    // section and re-parse the whole document on each typed character.
    if (yjsChanged || input.state) this.notify();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
    this.doc.off("afterTransaction", this.invalidateCachedMarkdown);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private adoptBootstrap(bootstrap: LiveBootstrapInput): void {
    Y.applyUpdate(this.doc, bootstrap.yjsUpdate, this.origin);
    this.adoptState(bootstrap.state);
    for (const ref of this.topology) {
      if (!this.doc.share.has(SectionId.text(ref.id))) {
        throw new Error(
          `LiveSectionReplica bootstrap incomplete: topology id "${SectionId.text(ref.id)}" has no fragment.`,
        );
      }
    }
    this.currentlyLiveAuthority = true;
    this.notify();
  }

  private adoptState(state: WireLiveSectionsState): void {
    this.topology = state.topology.map((ref) => ({
      id: SectionId.brand(ref.fragment_key),
      headingPath: [...ref.heading_path],
      headingLevel: ref.heading_level,
    }));
    this.topologyIds = new Set(this.topology.map((r) => r.id));
    this.blocked = new Set(state.blocked_section_ids.map((k) => SectionId.brand(k)));
    this.pending = new Map(
      state.pending_sections.map((p) => [
        SectionId.brand(p.fragment_key),
        { writerId: p.writer_id, writerDisplayName: p.writer_display_name },
      ]),
    );
    this.editorsFrozenByPauseMirror = state.publish_pause_join_mirror === "pause_active_editors_frozen";
    this.publishDecision = state.publish_decision ?? null;
    this._boundProposalId = state.bound_proposal_id ?? null;
    this._claimedSections = (state.bound_proposal_claimed_sections ?? []).map((c) => ({
      headingPath: [...c.heading_path],
      fragmentKey: c.fragment_key,
    }));
    this._editorFocusSectionIds = [...(state.editor_focus_section_ids ?? [])];
  }

  private makeHandle(id: SectionId): LiveSectionHandle {
    const key = SectionId.text(id);
    return {
      id,
      readMarkdown: () => {
        const cached = this.markdownCache.get(key);
        if (cached !== undefined) return cached;
        const md = fragmentToMarkdown(this.doc, key) ?? "";
        this.markdownCache.set(key, md);
        return md;
      },
      isEditable: () => this.editingEnabled && !this.blocked.has(id) && !this.editorsFrozenByPauseMirror,
      createEditorBinding: () =>
        // The runtime shape is LiveEditorAttachFields; the public type hides it.
        ({ doc: this.doc, awareness: this.awareness, fragmentKey: key }) as unknown as LiveEditorBinding,
    };
  }

  private notify(): void {
    if (this.destroyed) return;
    for (const listener of this.listeners) listener();
  }
}

function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createLiveSectionReplica(doc?: Y.Doc, awareness?: Awareness): LiveSectionReplica {
  return new LiveSectionReplicaImpl(doc, awareness);
}
