/**
 * LiveFragmentStringsStore — backend boundary 1 (browser → live CRDT)
 *
 * Owns the live Y.Doc and an ordered list of opaque fragment keys. Runtime
 * code also routes crash-recovery sidecar coordination through this store so
 * settle ownership stays with the live boundary.
 *
 * Applies client Yjs updates, tracks which fragment keys have been modified
 * since the staged store last accepted them (aheadOfStaged), and exposes
 * content read/replace primitives used by the boundary-2 acceptance path
 * and by server injection.
 */

import * as Y from "yjs";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from "y-prosemirror";
import { getBackendSchema } from "./ydoc-fragments.js";
import { fragmentFromRemark, type FragmentContent } from "../storage/section-formatting.js";
import type { SnapshotResult, RawFragmentRecoveryBuffer } from "../storage/raw-fragment-recovery-buffer.js";
import type { AcceptResult, SettleResult } from "../storage/staged-sections-store.js";

/** Unforgeable symbol stamped on server-authoritative Y.Doc mutations so the
 *  afterTransaction guard suppresses ahead-of-staged marking. */
export const SERVER_INJECTION_ORIGIN = Symbol("server-injection");

export class LiveFragmentStringsStore {
  readonly ydoc: Y.Doc;
  readonly docPath: string;

  private orderedKeys: string[];
  private readonly aheadOfStagedKeys = new Set<string>();
  private readonly fragmentWriterIds = new Map<string, Set<string>>();
  private recoveryBuffer: RawFragmentRecoveryBuffer | null = null;

  /** Fragment keys touched by the current transaction — populated by the
   *  afterTransaction listener, drained by `applyClientUpdate`. */
  private readonly touchedThisTransaction = new Set<string>();

  /** Y.AbstractType → fragment key name reverse lookup. Rebuilt lazily when
   *  `ydoc.share` grows (new fragments appear during structural reconciliation). */
  private reverseMap = new Map<object, string>();
  private lastShareSize = 0;

  constructor(ydoc: Y.Doc, orderedKeys: string[], docPath: string) {
    this.ydoc = ydoc;
    this.orderedKeys = [...orderedKeys];
    this.docPath = docPath;

    this.ydoc.on("afterTransaction", (txn: Y.Transaction) => {
      if (txn.origin === SERVER_INJECTION_ORIGIN) return;
      if (this.ydoc.share.size !== this.lastShareSize) this.rebuildReverseMap();
      for (const [type] of txn.changed) {
        let current: unknown = type;
        while ((current as { _item?: { parent?: unknown } })._item?.parent) {
          current = (current as { _item: { parent: unknown } })._item.parent;
        }
        const name = this.reverseMap.get(current as object);
        if (name) {
          this.touchedThisTransaction.add(name);
          this.aheadOfStagedKeys.add(name);
        }
      }
    });
  }

  attachRecoveryBuffer(recoveryBuffer: RawFragmentRecoveryBuffer): void {
    this.recoveryBuffer = recoveryBuffer;
  }

  // ─── Fragment key access ──────────────────────────────────────────

  getFragmentKeys(): string[] {
    return [...this.orderedKeys];
  }

  hasFragmentKey(fragmentKey: string): boolean {
    return this.orderedKeys.includes(fragmentKey);
  }

  getWriterIdsForFragment(fragmentKey: string): string[] {
    return [...(this.fragmentWriterIds.get(fragmentKey) ?? new Set())].sort();
  }

  getWriterIdsForFragments(fragmentKeys: Iterable<string>): string[] {
    const writerIds = new Set<string>();
    for (const fragmentKey of fragmentKeys) {
      for (const writerId of this.fragmentWriterIds.get(fragmentKey) ?? []) {
        writerIds.add(writerId);
      }
    }
    return [...writerIds].sort();
  }

  setFragmentWriterIds(fragmentKey: string, writerIds: Iterable<string>): void {
    const normalized = new Set<string>();
    for (const writerId of writerIds) {
      const trimmed = writerId.trim();
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }
    if (normalized.size === 0) {
      this.fragmentWriterIds.delete(fragmentKey);
      return;
    }
    this.fragmentWriterIds.set(fragmentKey, normalized);
  }

  // ─── Content reads ────────────────────────────────────────────────

  /**
   * Read the full fragment content (heading + body for non-root, body for
   * root/BFH) from the Y.Doc. Content is sourced directly from Yjs state,
   * so it is always current — never stale.
   */
  readFragmentString(fragmentKey: string): FragmentContent {
    const pmJson = yDocToProsemirrorJSON(this.ydoc, fragmentKey);
    return fragmentFromRemark(jsonToMarkdown(pmJson as Record<string, unknown>));
  }

  // ─── Content writes ───────────────────────────────────────────────

  /**
   * Replace a single fragment's content. `origin` is an explicit parameter —
   * pass `SERVER_INJECTION_ORIGIN` to suppress ahead-of-staged tracking for
   * server-authoritative writes.
   */
  replaceFragmentString(fragmentKey: string, content: FragmentContent, origin: unknown = undefined): void {
    this.ydoc.transact(() => {
      const fragment = this.ydoc.getXmlFragment(fragmentKey);
      while (fragment.length > 0) fragment.delete(0, 1);
    }, origin);

    const pmJson = markdownToJSON(content);
    const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
    Y.applyUpdate(this.ydoc, Y.encodeStateAsUpdate(tempDoc), origin);
    tempDoc.destroy();
  }

  /**
   * Replace many fragments at once. Clears all target fragments in one
   * transaction (no partial-state visibility), then merges all populating
   * updates into a single `Y.applyUpdate` call.
   */
  replaceFragmentStrings(map: Map<string, FragmentContent>, origin: unknown = undefined): void {
    this.replaceAndClearFragmentStrings(map, [], origin);
  }

  /**
   * Replace `writeMap` keys with new content AND clear `clearKeys` to empty,
   * all within a single transaction (no partial-state visibility).
   *
   * Used by the structural-reconciliation path where some fragments must be
   * wiped (because the skeleton entry was removed) while others receive new
   * content from the fresh overlay state.
   */
  replaceAndClearFragmentStrings(
    writeMap: Map<string, FragmentContent>,
    clearKeys: Iterable<string>,
    origin: unknown = undefined,
  ): void {
    const keysToClear = new Set<string>();
    for (const key of clearKeys) keysToClear.add(key);
    for (const key of writeMap.keys()) keysToClear.add(key);
    if (keysToClear.size === 0) return;

    this.ydoc.transact(() => {
      for (const fragmentKey of keysToClear) {
        const fragment = this.ydoc.getXmlFragment(fragmentKey);
        while (fragment.length > 0) fragment.delete(0, 1);
      }
    }, origin);

    const pendingUpdates: Uint8Array[] = [];
    for (const [fragmentKey, content] of writeMap) {
      const pmJson = markdownToJSON(content);
      const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
      pendingUpdates.push(Y.encodeStateAsUpdate(tempDoc));
      tempDoc.destroy();
    }
    if (pendingUpdates.length > 0) {
      Y.applyUpdate(this.ydoc, Y.mergeUpdates(pendingUpdates), origin);
    }
  }

  // ─── Boundary-1: client update application ────────────────────────

  /**
   * Apply a Yjs binary update received from a client. Marks touched fragment
   * keys ahead-of-staged and returns the exact set of keys the update
   * affected. The caller (DocSession) uses this return value as the single
   * source of truth for per-user dirty attribution — it MUST NOT infer scope
   * from focus or ambient state.
   */
  applyClientUpdate(writerId: string, update: Uint8Array, origin: unknown): ReadonlySet<string> {
    this.touchedThisTransaction.clear();
    Y.applyUpdate(this.ydoc, update, origin);
    const touched = new Set(this.touchedThisTransaction);
    for (const fragmentKey of touched) {
      this.noteWriterForFragment(fragmentKey, writerId);
    }
    this.touchedThisTransaction.clear();
    return touched;
  }

  // ─── Boundary-2 tracking (ahead-of-staged) ────────────────────────

  noteAheadOfStaged(fragmentKey: string): void {
    this.aheadOfStagedKeys.add(fragmentKey);
  }

  isAheadOfStaged(fragmentKey: string): boolean {
    return this.aheadOfStagedKeys.has(fragmentKey);
  }

  getAheadOfStagedKeys(): ReadonlySet<string> {
    return this.aheadOfStagedKeys;
  }

  clearAheadOfStaged(fragmentKeys: Iterable<string>): void {
    for (const key of fragmentKeys) this.aheadOfStagedKeys.delete(key);
  }

  async snapshotToRecovery(scope: ReadonlySet<string> | "all"): Promise<SnapshotResult> {
    return await this.requireRecoveryBuffer().snapshotFromLive(this, scope);
  }

  async listPersistedFragmentKeys(): Promise<string[]> {
    return await this.requireRecoveryBuffer().listFragmentKeys();
  }

  async readPersistedFragment(fragmentKey: string): Promise<string | null> {
    return await this.requireRecoveryBuffer().readFragment(fragmentKey);
  }

  async settleFragment(
    stagedSections: {
      acceptLiveFragments(
        liveStore: LiveFragmentStringsStore,
        scope: ReadonlySet<string> | "all",
      ): Promise<AcceptResult>;
    },
    fragmentKey: string,
  ): Promise<SettleResult> {
    this.noteAheadOfStaged(fragmentKey);

    const recoveryBuffer = this.requireRecoveryBuffer();
    const begun = recoveryBuffer.tryBeginSettleWindow(fragmentKey);
    if (!begun) {
      return emptySettleResult(false);
    }

    let settleResult: SettleResult = emptySettleResult(false);
    try {
      const result = await stagedSections.acceptLiveFragments(this, new Set([fragmentKey]));
      this.applyAcceptedFragmentOwnership(fragmentKey, result);
      settleResult = { ...result, staleOverlay: false };
    } finally {
      const { blockedWriteAttempted } = recoveryBuffer.endSettleWindow(fragmentKey);
      settleResult = { ...settleResult, staleOverlay: blockedWriteAttempted };
    }
    return settleResult;
  }

  async applyAbsorbedFragmentCleanup(
    stagedSections: {
      applyAbsorbedFragmentCleanup(fragmentKeys: Iterable<string>): void | Promise<void>;
    },
    fragmentKeys: Iterable<string>,
  ): Promise<void> {
    const cleanupKeys = [...new Set(fragmentKeys)];
    await stagedSections.applyAbsorbedFragmentCleanup(cleanupKeys);
    await this.requireRecoveryBuffer().deleteFragments(cleanupKeys);
    for (const fragmentKey of cleanupKeys) {
      this.fragmentWriterIds.delete(fragmentKey);
    }
  }

  async resetSessionStores(
    stagedSections: {
      _resetForDocPath(): Promise<void>;
    },
  ): Promise<void> {
    await stagedSections._resetForDocPath();
    await this.requireRecoveryBuffer()._resetForDocPath();
    this.fragmentWriterIds.clear();
  }

  private applyAcceptedFragmentOwnership(fragmentKey: string, result: AcceptResult): void {
    const inheritedWriterIds = new Set<string>();
    for (const writerId of this.fragmentWriterIds.get(fragmentKey) ?? []) {
      inheritedWriterIds.add(writerId);
    }
    for (const deletedKey of result.deletedKeys) {
      for (const writerId of this.fragmentWriterIds.get(deletedKey) ?? []) {
        inheritedWriterIds.add(writerId);
      }
    }
    if (inheritedWriterIds.size === 0) return;
    for (const writtenKey of result.writtenKeys) {
      const merged = new Set(this.fragmentWriterIds.get(writtenKey) ?? []);
      for (const writerId of inheritedWriterIds) {
        merged.add(writerId);
      }
      this.fragmentWriterIds.set(writtenKey, merged);
    }
  }

  private noteWriterForFragment(fragmentKey: string, writerId: string): void {
    const trimmed = writerId.trim();
    if (trimmed.length === 0) return;
    let writerIds = this.fragmentWriterIds.get(fragmentKey);
    if (!writerIds) {
      writerIds = new Set<string>();
      this.fragmentWriterIds.set(fragmentKey, writerIds);
    }
    writerIds.add(trimmed);
  }

  private rebuildReverseMap(): void {
    this.reverseMap = new Map();
    for (const [name, shared] of this.ydoc.share) {
      this.reverseMap.set(shared, name);
    }
    this.lastShareSize = this.ydoc.share.size;
  }

  private requireRecoveryBuffer(): RawFragmentRecoveryBuffer {
    if (!this.recoveryBuffer) {
      throw new Error(`LiveFragmentStringsStore for "${this.docPath}" is missing its recovery buffer attachment.`);
    }
    return this.recoveryBuffer;
  }
}

function emptySettleResult(staleOverlay: boolean): SettleResult {
  return {
    acceptedKeys: new Set(),
    writtenKeys: [],
    deletedKeys: [],
    staleOverlay,
  };
}
