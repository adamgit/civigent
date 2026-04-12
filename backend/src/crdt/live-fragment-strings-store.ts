/**
 * LiveFragmentStringsStore — backend boundary 1 (browser → live CRDT)
 *
 * Owns the live Y.Doc and an ordered list of opaque fragment keys. Knows
 * nothing about heading paths, section files, skeletons, or disk formats.
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

/** Unforgeable symbol stamped on server-authoritative Y.Doc mutations so the
 *  afterTransaction guard suppresses ahead-of-staged marking. */
export const SERVER_INJECTION_ORIGIN = Symbol("server-injection");

export interface StructuralChange {
  /** New document-order fragment-key list after the mutation. */
  orderedKeys: string[];
  /** Content to write for new/changed fragment keys. */
  contentByKey: ReadonlyMap<string, FragmentContent>;
  /** Fragment keys to clear from the Y.Doc. */
  removedKeys: ReadonlySet<string>;
}

export class LiveFragmentStringsStore {
  readonly ydoc: Y.Doc;
  readonly docPath: string;

  private orderedKeys: string[];
  private readonly aheadOfStagedKeys = new Set<string>();

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

  // ─── Fragment key access ──────────────────────────────────────────

  getFragmentKeys(): string[] {
    return [...this.orderedKeys];
  }

  hasFragmentKey(fragmentKey: string): boolean {
    return this.orderedKeys.includes(fragmentKey);
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
  replaceFragmentString(fragmentKey: string, content: FragmentContent, origin: unknown): void {
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
  replaceFragmentStrings(map: Map<string, FragmentContent>, origin: unknown): void {
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
    origin: unknown,
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
  applyClientUpdate(_writerId: string, update: Uint8Array, origin: unknown): ReadonlySet<string> {
    this.touchedThisTransaction.clear();
    Y.applyUpdate(this.ydoc, update, origin);
    const touched = new Set(this.touchedThisTransaction);
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

  // ─── Structural reconciliation ────────────────────────────────────

  /**
   * Apply a structural change returned by `StagedSectionsStore.acceptLiveFragments`.
   * Clears removed fragments, writes new fragment content, and updates the
   * ordered key list. All Y.Doc writes are stamped with `SERVER_INJECTION_ORIGIN`
   * so the afterTransaction guard does not re-mark them ahead-of-staged.
   *
   * Does not know or care WHY the structure changed — interpretation happens
   * inside the staged store.
   */
  applyStructuralChange(change: StructuralChange): void {
    if (change.removedKeys.size > 0) {
      this.ydoc.transact(() => {
        for (const fragmentKey of change.removedKeys) {
          const fragment = this.ydoc.getXmlFragment(fragmentKey);
          while (fragment.length > 0) fragment.delete(0, 1);
        }
      }, SERVER_INJECTION_ORIGIN);
    }

    if (change.contentByKey.size > 0) {
      const writeMap = new Map<string, FragmentContent>();
      for (const [key, content] of change.contentByKey) writeMap.set(key, content);
      this.replaceFragmentStrings(writeMap, SERVER_INJECTION_ORIGIN);
    }

    this.orderedKeys = [...change.orderedKeys];
    // Structural change definitionally means the share map grew/shrunk —
    // invalidate the reverse map so the next client txn rebuilds it.
    this.lastShareSize = -1;
  }

  private rebuildReverseMap(): void {
    this.reverseMap = new Map();
    for (const [name, shared] of this.ydoc.share) {
      this.reverseMap.set(shared, name);
    }
    this.lastShareSize = this.ydoc.share.size;
  }
}
