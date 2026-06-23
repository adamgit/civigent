/**
 * LiveFragmentStringsStore — the thin Y.Doc fragment adapter.
 *
 * Owns the live Y.Doc and an ordered list of opaque fragment keys, and is the
 * single place that reads/writes per-section Y.XmlFragment content as markdown.
 * It does NOT own durability (the `inprogress` proposal content tree is the
 * durable in-flight state — spec 05 §Session Persistence), and it does NOT own
 * settle/accept/staged-store coordination, ahead-of-staged tracking, raw-fragment
 * recovery, or any `SERVER_INJECTION_ORIGIN` reinjection semantics — all of which
 * belonged to the removed `sessions/` mirror.
 *
 * Responsibilities that remain:
 *   - markdown roundtrip: `readFragmentString` / `replaceFragmentString(s)` /
 *     `replaceAndClearFragmentStrings`
 *   - `applyClientUpdate`: apply an inbound client Yjs update and report the
 *     exact set of touched fragment keys (the DocSession actor uses this set as
 *     the single source of truth for per-section activity attribution)
 *   - fragment-key validation (`hasFragmentKey` / `getFragmentKeys`)
 *   - writer attribution (`fragmentWriterIds`) for co-author lists
 *
 * Pure markdown/fragment helpers (heading/body composition, fragment-key
 * derivation) live in `../storage/section-formatting.ts` and `./ydoc-fragments.ts`.
 */

import * as Y from "yjs";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from "y-prosemirror";
import { getBackendSchema } from "./ydoc-fragments.js";
import { fragmentFromRemark, type FragmentContent } from "../storage/section-formatting.js";

/**
 * The top-level shared types stored in `Y.Doc.share` and keyed by
 * `Y.Transaction.changed` — derived from the official Yjs declarations so we
 * never spell `any` or reach into a private Yjs internal type.
 */
type YSharedType = Y.Doc["share"] extends Map<string, infer V> ? V : never;

/**
 * Yjs ↔ ProseMirror-JSON boundary. `yDocToProsemirrorJSON` is weakly typed
 * (`Record<string, any>`); this is the single adapter that crosses that boundary
 * into the `Record<string, unknown>` shape `jsonToMarkdown` consumes (the
 * `any → unknown` widening is implicit and safe), so no `as` assertion is needed
 * at the call sites.
 */
function fragmentToMarkdown(doc: Y.Doc, fragmentKey: string): FragmentContent {
  const pmJson: Record<string, unknown> = yDocToProsemirrorJSON(doc, fragmentKey);
  return fragmentFromRemark(jsonToMarkdown(pmJson));
}

export class LiveFragmentStringsStore {
  readonly ydoc: Y.Doc;
  readonly docPath: string;

  private orderedKeys: string[];
  private readonly fragmentWriterIds = new Map<string, Set<string>>();

  /** Fragment keys touched by the current transaction — populated by the
   *  afterTransaction listener, drained by `applyClientUpdate`. */
  private readonly touchedThisTransaction = new Set<string>();

  /** Y.AbstractType → fragment key name reverse lookup. Rebuilt lazily when
   *  `ydoc.share` grows (new fragments appear during structural reconciliation). */
  private reverseMap = new Map<YSharedType, string>();
  private lastShareSize = 0;

  constructor(ydoc: Y.Doc, orderedKeys: string[], docPath: string) {
    this.ydoc = ydoc;
    this.orderedKeys = [...orderedKeys];
    this.docPath = docPath;

    this.ydoc.on("afterTransaction", (txn: Y.Transaction) => {
      if (this.ydoc.share.size !== this.lastShareSize) this.rebuildReverseMap();
      for (const [type] of txn.changed) {
        // Walk up to the top-level shared type via the public `parent` getter
        // (no private `_item` traversal), then attribute the change to its key.
        let current: YSharedType = type;
        let parent = current.parent;
        while (parent) {
          current = parent;
          parent = current.parent;
        }
        const name = this.reverseMap.get(current);
        if (name) {
          this.touchedThisTransaction.add(name);
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

  /** Register a fragment key as known to the adapter (e.g. after a structural
   *  materialization introduced a new section). Idempotent. */
  registerFragmentKey(fragmentKey: string): void {
    if (!this.orderedKeys.includes(fragmentKey)) {
      this.orderedKeys.push(fragmentKey);
    }
  }

  /**
   * Forget a fragment key the adapter no longer tracks (e.g. structural
   * reconciliation merged/removed the section it represented). Drops the key
   * from the ordered key list and its writer-attribution set so subsequent
   * `getFragmentKeys()` callers (quiescence normalization, co-author lists) no
   * longer see the dead section. Idempotent. The underlying Y.XmlFragment is
   * left empty in `ydoc.share` (Y.js has no top-level type deletion); callers
   * that need it cleared must do so in the same transaction (see
   * `replaceAndClearFragmentStrings`). */
  unregisterFragmentKey(fragmentKey: string): void {
    const idx = this.orderedKeys.indexOf(fragmentKey);
    if (idx !== -1) this.orderedKeys.splice(idx, 1);
    this.fragmentWriterIds.delete(fragmentKey);
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
    return fragmentToMarkdown(this.ydoc, fragmentKey);
  }

  /**
   * Capture the current full Y.Doc state as a binary update (C3-perf). This is a
   * single O(structs) binary serialization — far cheaper than a markdown
   * roundtrip per fragment — and lets a caller defer the (expensive) per-fragment
   * markdown reconstruction to the rare subset it actually needs (e.g. only the
   * fragments a competing proposal blocked, which must be reverted to their
   * pre-edit content).
   */
  captureState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  /**
   * Reconstruct the markdown content of specific fragment keys from a previously
   * `captureState()`-ed snapshot (C3-perf). Builds ONE throwaway Y.Doc from the
   * snapshot and reads only the requested keys, so the per-fragment markdown
   * roundtrip is paid only for those keys (not the whole document).
   */
  snapshotFragmentContentFromState(
    state: Uint8Array,
    fragmentKeys: Iterable<string>,
  ): Map<string, FragmentContent> {
    const result = new Map<string, FragmentContent>();
    const keys = [...fragmentKeys];
    if (keys.length === 0) return result;
    const tmp = new Y.Doc();
    Y.applyUpdate(tmp, state);
    try {
      for (const fragmentKey of keys) {
        result.set(fragmentKey, fragmentToMarkdown(tmp, fragmentKey));
      }
    } finally {
      tmp.destroy();
    }
    return result;
  }

  // ─── Content writes ───────────────────────────────────────────────

  /**
   * Replace a single fragment's content. `origin` is forwarded to the Y.Doc
   * transaction so callers (e.g. the DocSession actor's structural mutations)
   * can tag server-authored writes for their own observers.
   */
  replaceFragmentString(fragmentKey: string, content: FragmentContent, origin: unknown = undefined): void {
    this.registerFragmentKey(fragmentKey);
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
   * content.
   */
  replaceAndClearFragmentStrings(
    writeMap: Map<string, FragmentContent>,
    clearKeys: Iterable<string>,
    origin: unknown = undefined,
  ): void {
    const keysToClear = new Set<string>();
    for (const key of clearKeys) keysToClear.add(key);
    for (const key of writeMap.keys()) {
      keysToClear.add(key);
      this.registerFragmentKey(key);
    }
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

  // ─── Client update application ─────────────────────────────────────

  /**
   * Apply a Yjs binary update received from a client. Returns the exact set of
   * fragment keys the update affected and records the writer for each touched
   * key (for co-author attribution). The caller (DocSession actor) uses this
   * return value as the single source of truth for per-section activity — it
   * MUST NOT infer scope from focus or ambient state.
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
}
