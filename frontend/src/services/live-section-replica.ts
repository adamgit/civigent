import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { fragmentToMarkdown } from "./fragment-to-markdown";
import { SectionId, type LiveSectionRef } from "../types/live-sections";
import type { WireLiveSectionsState } from "../types/shared";

/** Yjs transaction origin stamped on every server-delivered apply (bootstrap
 *  and update frames). Lets transport-level waiters (e.g. the live-move caret
 *  restore) recognize server fan-out on the shared doc without the provider
 *  ever applying content itself. */
export const LIVE_SECTION_SERVER_APPLY_ORIGIN: unique symbol = Symbol("live-section-server-apply");

declare const LiveEditorBindingBrand: unique symbol;

export interface LiveEditorBinding {
  readonly [LiveEditorBindingBrand]: "LiveEditorBinding";
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

  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  constructor(doc?: Y.Doc, awareness?: Awareness) {
    this.doc = doc ?? new Y.Doc();
    this.awareness = awareness ?? new Awareness(this.doc);
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
    if (input.yjsUpdate) Y.applyUpdate(this.doc, input.yjsUpdate, this.origin);
    if (input.state) this.adoptState(input.state);
    this.notify();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
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
  }

  private makeHandle(id: SectionId): LiveSectionHandle {
    const key = SectionId.text(id);
    return {
      id,
      readMarkdown: () => fragmentToMarkdown(this.doc, key) ?? "",
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

export function createLiveSectionReplica(doc?: Y.Doc, awareness?: Awareness): LiveSectionReplica {
  return new LiveSectionReplicaImpl(doc, awareness);
}
