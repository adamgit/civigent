import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { fragmentToMarkdown } from "./fragment-to-markdown";
import { SectionId, type LiveSectionRef } from "../types/live-sections";
import type { WireLiveSectionsState } from "../types/shared";

export interface LiveEditorBinding {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly fragmentKey: string;
}

export interface LiveSectionHandle {
  readonly id: SectionId;
  readMarkdown(): string;
  isEditable(): boolean;
  createEditorBinding(): LiveEditorBinding;
}

export interface LiveSectionReplica {
  readonly hasAuthoritativeBootstrap: boolean;
  subscribe(listener: () => void): () => void;
  getTopology(): readonly LiveSectionRef[];
  lookupInTopology(sectionId: SectionId): LiveSectionHandle | undefined;
  requireLiveSection(sectionId: SectionId): LiveSectionHandle | undefined;
  isPending(sectionId: SectionId): boolean;
  /** True when the server marked this section blocked (lock/contention). */
  isBlocked(sectionId: SectionId): boolean;
  /** Fragment keys with uncommitted (pending) live edits, for save-status. */
  getPendingSectionKeys(): readonly string[];
  /** True while the join-mirror or a live pause has editors frozen. */
  isPublishPauseMirrorActive(): boolean;
  setLocalWriteCapability(enabled: boolean): void;
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

export class LiveSectionReplicaImpl implements LiveSectionReplica {
  private readonly doc: Y.Doc;
  private readonly awareness: Awareness;
  private readonly origin: symbol = Symbol("live-section-replica");

  private _ready = false;
  private editingEnabled = false;
  private docSessionId: string | null = null;

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

  get hasAuthoritativeBootstrap(): boolean {
    return this._ready;
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

  lookupInTopology(sectionId: SectionId): LiveSectionHandle | undefined {
    if (!this.topologyIds.has(sectionId)) return undefined;
    return this.makeHandle(sectionId);
  }

  requireLiveSection(sectionId: SectionId): LiveSectionHandle | undefined {
    if (!this._ready) {
      throw new Error(
        "LiveSectionReplica.requireLiveSection called before an authoritative bootstrap (hasAuthoritativeBootstrap === false).",
      );
    }
    if (!this.topologyIds.has(sectionId)) return undefined;
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

  setLocalWriteCapability(enabled: boolean): void {
    if (this.editingEnabled === enabled) return;
    this.editingEnabled = enabled;
    this.notify();
  }

  applyBootstrap(input: LiveBootstrapInput): void {
    if (this.destroyed) return;
    this.docSessionId = input.docSessionId;
    Y.applyUpdate(this.doc, input.yjsUpdate, this.origin);
    this.adoptState(input.state);
    for (const ref of this.topology) {
      if (!this.doc.share.has(SectionId.text(ref.id))) {
        throw new Error(
          `LiveSectionReplica bootstrap incomplete: topology id "${SectionId.text(ref.id)}" has no fragment.`,
        );
      }
    }
    this._ready = true;
    this.notify();
  }

  applyUpdate(input: LiveUpdateInput): void {
    if (this.destroyed) return;
    if (input.yjsUpdate) Y.applyUpdate(this.doc, input.yjsUpdate, this.origin);
    if (input.state) this.adoptState(input.state);
    this.notify();
  }

  resetForSessionEnd(): void {
    if (this.destroyed) return;
    this._ready = false;
    this.editingEnabled = false;
    this.docSessionId = null;
    this.topology = [];
    this.topologyIds = new Set();
    this.blocked = new Set();
    this.pending = new Map();
    this.editorsFrozenByPauseMirror = false;
    this.notify();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
    this.awareness.destroy();
    this.doc.destroy();
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
      createEditorBinding: () => ({ doc: this.doc, awareness: this.awareness, fragmentKey: key }),
    };
  }

  private notify(): void {
    if (this.destroyed) return;
    for (const listener of this.listeners) listener();
  }
}

export function createLiveSectionReplica(doc?: Y.Doc, awareness?: Awareness): LiveSectionReplicaImpl {
  return new LiveSectionReplicaImpl(doc, awareness);
}
