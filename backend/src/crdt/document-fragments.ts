/**
 * DocumentFragments — Y.Doc ↔ Disk Content Boundary
 *
 * Single owner of fragment content format knowledge. Fragments store
 * heading+body content (the heading is the first node in the Y.XmlFragment,
 * editable inline). Before-first-heading sections (level=0, heading="") store body only.
 *
 * Pairs a Y.Doc with a DocumentSkeleton — operations that must touch
 * both (construct, import to session overlay, assemble) are methods here.
 */

import * as Y from "yjs";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from "y-prosemirror";
import { DocumentSkeletonInternal, type DocumentSkeleton, type FlatEntry } from "../storage/document-skeleton.js";
import { parseDocumentMarkdown } from "../storage/markdown-sections.js";
import { OverlayContentLayer, type UpsertSectionFromMarkdownDetailedResult } from "../storage/content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getSessionDocsContentRoot } from "../storage/data-root.js";
import {
  fragmentKeyFromSectionFile,
  sectionFileFromFragmentKey,
  getBackendSchema,
} from "./ydoc-fragments.js";
import {
  bodyFromParser,
  bodyAsFragment,
  fragmentFromRemark,
  buildFragmentContent as buildFragmentContentFn,
  fragmentAsBody,
  type SectionBody,
  type FragmentContent,
} from "../storage/section-formatting.js";

// ─── Server injection origin ──────────────────────────────────────

/** Unforgeable Symbol used to stamp server-authoritative Y.Doc mutations.
 *  The afterTransaction guard checks txn.origin === SERVER_INJECTION_ORIGIN
 *  to suppress dirty tracking for injected updates. */
export const SERVER_INJECTION_ORIGIN = Symbol('server-injection');

// ─── Import result ───────────────────────────────────────────────

export interface ImportDirtyFragmentsToSessionOverlayResult {
  /** Fragment keys whose content was written during the import. */
  writtenKeys: string[];
  /** Fragment keys that were deleted (due to heading renames/removals). */
  deletedKeys: string[];
}

export interface NormalizeResult {
  changed: boolean;
  createdKeys: string[];
  removedKeys: string[];
}

// ─── DocumentFragments ───────────────────────────────────────────────
// Content model: body files on disk end with exactly one \n. markdownToJSON()
// normalizes trailing whitespace, so in-memory body strings need not be
// pre-trimmed before entering the CRDT pipeline.

export class DocumentFragments {
  /** The Y.Doc instance. Callers need direct access for WS sync
   *  (Y.applyUpdate, Y.encodeStateVector, Y.encodeStateAsUpdate).
   *  Content reads/writes MUST go through DocumentFragments methods. */
  readonly ydoc: Y.Doc;

  /** Skeleton view used by the fragment-store. NOT readonly: structural
   *  mutations performed by `OverlayContentLayer.upsertSection(...)` /
   *  `OverlayContentLayer.upsertSectionMergingToPrevious(...)`
   *  operate on a fresh writable skeleton fetched from disk via
   *  `getWritableSkeleton(...)`, then flush to overlay. After such a mutation
   *  this reference is stale, so `applyDetailedUpsertResult` re-loads it from
   *  overlay disk and rebuilds the fragment indices. See
   *  `acquireDocSession` (`ydoc-lifecycle.ts`) for the original construction. */
  skeleton: Pick<DocumentSkeleton, "forEachSection">;

  readonly docPath: string;

  /** Fragment keys modified since last session-overlay import. Updated on Y.Doc changes,
   *  cleared after a successful import. Separate from perUserDirty which
   *  tracks per-user attribution for the Mirror panel. */
  readonly dirtyKeys = new Set<string>();
  private readonly fragmentKeyByHeadingPathKey = new Map<string, string>();
  private readonly headingPathByFragmentKey = new Map<string, string[]>();
  private readonly sectionFileByFragmentKey = new Map<string, string>();
  private orderedFragmentKeys: string[] = [];

  /**
   * Construct a DocumentFragments around a caller-supplied Y.Doc and skeleton.
   *
   * This is a plain constructor: it performs no disk reads, no source-selection
   * policy, no orphan scan, and no recovery decisions. Callers (typically
   * `acquireDocSession`) must load the skeleton, choose per-section startup
   * content from runtime sources, and apply that content via
   * `replaceFragmentsFromProvidedContent(...)` after construction.
   */
  constructor(ydoc: Y.Doc, skeleton: Pick<DocumentSkeleton, "forEachSection">, docPath: string) {
    this.ydoc = ydoc;
    this.skeleton = skeleton;
    this.docPath = docPath;
    this.rebuildIndexFromSkeleton();
  }

  static fragmentKeyFor(entry: FlatEntry): string {
    return fragmentKeyFromSectionFile(entry.sectionFile, entry.headingPath.length === 0);
  }

  static isBeforeFirstHeading(entry: Pick<FlatEntry, "headingPath">): boolean {
    return entry.headingPath.length === 0;
  }

  // ─── Dirty tracking ────────────────────────────────────────────

  /** Mark a fragment key as dirty (modified since last session-overlay import). */
  markDirty(fragmentKey: string): void {
    this.dirtyKeys.add(fragmentKey);
  }

  getFragmentKeys(): string[] {
    return [...this.orderedFragmentKeys];
  }

  requireFragmentKeyForHeadingPath(headingPath: string[]): string {
    const fragmentKey = this.findFragmentKeyForHeadingPath(headingPath);
    if (fragmentKey) return fragmentKey;
    throw new Error(
      `No live fragment key exists for headingPath=[${headingPath.join(" > ")}] in "${this.docPath}".`,
    );
  }

  findFragmentKeyForHeadingPath(headingPath: string[]): string | null {
    return this.fragmentKeyByHeadingPathKey.get(SectionRef.headingKey([...headingPath])) ?? null;
  }

  requireHeadingPathForFragmentKey(fragmentKey: string): string[] {
    const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
    if (headingPath) return headingPath;
    throw new Error(`No live heading path exists for fragmentKey="${fragmentKey}" in "${this.docPath}".`);
  }

  findHeadingPathForFragmentKey(fragmentKey: string): string[] | null {
    const headingPath = this.headingPathByFragmentKey.get(fragmentKey);
    return headingPath ? [...headingPath] : null;
  }

  /**
   * Detect a fragment whose CRDT content has had its heading deleted —
   * i.e. the parsed payload is one level-0 orphan with non-empty body
   * AND the fragment is NOT the BFH (which legitimately has headingPath=[]).
   * Used by `normalizeStructure` to recursively pre-normalize chains of
   * orphan-only predecessors before dispatching to the content layer.
   */
  private fragmentIsOrphanOnly(fragmentKey: string, headingPath: string[]): boolean {
    // BFH (headingPath=[]) is a legitimate level-0 root section, not a
    // pending heading deletion.
    if (headingPath.length === 0) return false;
    const content = this.extractMarkdown(fragmentKey);
    if (!content) return false;
    const parsed = parseDocumentMarkdown(content);
    if (parsed.length !== 1) return false;
    const only = parsed[0];
    if (only.level !== 0 || only.heading !== "") return false;
    return (only.body as unknown as string).trim().length > 0;
  }

  /**
   * Return the immediate predecessor fragment key in document order, or
   * null if `fragmentKey` is the first key (or not in the index at all).
   */
  private findImmediatePredecessorFragmentKey(fragmentKey: string): string | null {
    const idx = this.orderedFragmentKeys.indexOf(fragmentKey);
    if (idx <= 0) return null;
    return this.orderedFragmentKeys[idx - 1];
  }

  // ─── Content reads ─────────────────────────────────────────────

  /**
   * Read body-only content from a fragment, suitable for canonical disk writing.
   * Strips the leading heading line (fragments store heading+body).
   */
  readBodyForDisk(fragmentKey: string): SectionBody {
    const full = this.extractMarkdown(fragmentKey);
    const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
    if (headingPath && headingPath.length === 0) return fragmentAsBody(full);

    const firstRealSection = parseDocumentMarkdown(full).find((section) => section.headingPath.length > 0);
    return firstRealSection
      ? bodyFromParser(firstRealSection.body)
      : fragmentAsBody(full);
  }

  /**
   * Read the full fragment content (heading + body) from the Y.Doc.
   * Non-root fragments include their heading as the first node.
   */
  readFullContent(fragmentKey: string): FragmentContent {
    return this.extractMarkdown(fragmentKey);
  }

  /**
   * Read the live full content (heading+body) from the Y.Doc for a fragment.
   * Returns the current in-memory content (no disk staleness).
   * Returns null if the fragment key does not exist or has no content.
   */
  readLiveFragment(fragmentKey: string): FragmentContent | null {
    const content = this.extractMarkdown(fragmentKey);
    return content ? content : null;
  }

  /**
   * Bulk-read all live content from the Y.Doc for every section in the skeleton.
   * Returns Map<headingKey, FragmentContent> with the same key shape as readAllSectionsWithOverlay.
   * Only includes entries that have live Y.Doc content (non-null readLiveFragment).
   */
  readAllLiveContent(): Map<string, FragmentContent> {
    const result = new Map<string, FragmentContent>();
    for (const fragmentKey of this.getFragmentKeys()) {
      const live = this.readLiveFragment(fragmentKey);
      const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
      if (live != null && headingPath != null) {
        result.set(SectionRef.headingKey([...headingPath]), live);
      }
    }
    return result;
  }

  /**
   * Assemble the complete document markdown from all fragments.
   * Fragments store heading+body, so just concatenate them.
   */
  assembleMarkdown(): string {
    const parts: string[] = [];
    for (const fragmentKey of this.getFragmentKeys()) {
      const content = this.extractMarkdown(fragmentKey);
      if (content) {
        parts.push(content);
      }
    }

    return parts.join("\n\n");
  }

  // ─── Import dirty fragments to session overlay ─────────────────

  /**
   * Import dirty in-memory Y.Doc fragments into the session overlay.
   *
   * For every dirty fragment:
   * 1. Persist raw fragment markdown to `sessions/fragments/` (crash-safe source record)
   * 2. Reconcile markdown into `sessions/docs/content/` through OverlayContentLayer
   *    (may include structural outcomes such as rewrites/splits/deletions)
   * 3. Reconcile in-memory fragment indices/skeleton to the resulting on-disk structure
   */
  async importDirtyFragmentsToSessionOverlay(
    opts?: {
      fragmentKeys?: Set<string>;
      broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void;
    },
  ): Promise<ImportDirtyFragmentsToSessionOverlayResult> {
    if (this.dirtyKeys.size === 0) {
      return { writtenKeys: [], deletedKeys: [] };
    }

    const keysToFlush = opts?.fragmentKeys
      ? new Set([...opts.fragmentKeys].filter((key) => this.dirtyKeys.has(key)))
      : new Set(this.dirtyKeys);
    if (keysToFlush.size === 0) {
      return { writtenKeys: [], deletedKeys: [] };
    }
    if (opts?.fragmentKeys) {
      for (const key of keysToFlush) {
        this.dirtyKeys.delete(key);
      }
    } else {
      this.dirtyKeys.clear();
    }
  
    const ops = await this.getSessionStoreOps();
    const contentLayer = new OverlayContentLayer(getSessionDocsContentRoot(), getContentRoot());
  
    const writtenKeys: string[] = [];
    const deletedKeys: string[] = [];
    const droppedKeys: Array<{ fragmentKey: string; error: unknown }> = [];
  
    for (const fragmentKey of keysToFlush) {
      const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
      if (!headingPath) {
        droppedKeys.push({ fragmentKey, error: new Error("fragment key no longer resolves to a heading path") });
        continue;
      }
  
      const rawMarkdown = this.reconstructFullMarkdown(fragmentKey, 0, "");
      const fragmentFileId = sectionFileFromFragmentKey(fragmentKey);
      const rawFragmentFile = fragmentFileId.endsWith(".md")
        ? fragmentFileId
        : `${fragmentFileId}.md`;
  
      await ops.writeRawFragment(this.docPath, rawFragmentFile, rawMarkdown);
  
      const ref = new SectionRef(this.docPath, headingPath);
      const result = this.fragmentIsOrphanOnly(fragmentKey, headingPath)
        ? await contentLayer.upsertSectionMergingToPrevious(ref, rawMarkdown)
        : await (() => {
            const parsed = parseDocumentMarkdown(rawMarkdown);
            const firstHeaded = parsed.find((sec) => !(sec.level === 0 && sec.heading === ""));
            const heading = headingPath.length === 0
              ? ""
              : (firstHeaded?.heading ?? headingPath[headingPath.length - 1] ?? "");
            return contentLayer.upsertSection(ref, heading, rawMarkdown, { contentIsFullMarkdown: true });
          })();
  
      await this.applyDetailedUpsertResult(
        result,
        contentLayer,
        ops,
        opts,
      );
  
  
      writtenKeys.push(...result.writtenEntries.map((entry) => DocumentFragments.fragmentKeyFor(entry)));
      deletedKeys.push(...result.removedEntries.map((entry) => DocumentFragments.fragmentKeyFor(entry)));
    }
  
    if (droppedKeys.length > 0) {
      const details = droppedKeys
        .map(({ fragmentKey, error }) =>
          `${fragmentKey}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        )
        .join("\n");
      throw new Error(
        `importDirtyFragmentsToSessionOverlay(): ${droppedKeys.length} dirty fragment(s) could not be resolved in skeleton and were NOT written to disk:\n${details}`,
      );
    }
  
    return { writtenKeys, deletedKeys };
  }

  async normalizeStructure(
    fragmentKey: string,
    opts?: {
      broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void;
    },
  ): Promise<NormalizeResult> {
    const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
    if (!headingPath) {
      return { changed: false, createdKeys: [], removedKeys: [] };
    }

    // ── BUG2-followup-C — pre-normalize orphan-only predecessors ──────
    //
    // Convergence under arbitrary normalization key order requires that
    // when an orphan-only fragment X (= a fragment whose original heading
    // has been deleted in the CRDT, leaving only body content) is being
    // normalized, its immediate predecessor in document order must NOT
    // itself be a dirty orphan-only fragment. Otherwise the disk-level
    // merge in `OverlayContentLayer.deleteSectionAndAbsorbOrphanBody`
    // writes the merged body into the predecessor's body file, then
    // `reconcileLiveFragmentsFromDetailedResult` re-reads it back into
    // the predecessor's CRDT — clobbering the predecessor's pending
    // heading deletion and silently losing the user's intent.
    //
    // Pre-normalizing the predecessor recursively absorbs it into the
    // nearest stable section first. Each predecessor absorption deletes
    // that predecessor entry, so the chain is processed in document
    // order regardless of the order normalize was originally called in.
    // The recursion depth is bounded by the chain length of consecutive
    // orphan-only predecessors. See
    // `targeted-normalization-sequential-matrix.test.ts > sequential
    // normalization should converge to same final doc across key order
    // permutations`.
    if (this.fragmentIsOrphanOnly(fragmentKey, headingPath)) {
      while (true) {
        const predKey = this.findImmediatePredecessorFragmentKey(fragmentKey);
        if (!predKey) break;
        const predHeadingPath = this.findHeadingPathForFragmentKey(predKey);
        if (!predHeadingPath) break;
        if (!this.fragmentIsOrphanOnly(predKey, predHeadingPath)) break;
        await this.normalizeStructure(predKey, opts);
        // The recursive call deleted predKey and reloaded the skeleton.
        // The next loop iteration re-reads the new immediate predecessor.
      }

      // Our own fragmentKey/headingPath/sectionFile are unchanged: we
      // were never the absorption target of any recursive call (the
      // chain only ever absorbs predecessors INTO their own merge target,
      // never into the originating call's fragment).
    }

    const sectionFile = this.sectionFileByFragmentKey.get(fragmentKey);
    if (!sectionFile) {
      return { changed: false, createdKeys: [], removedKeys: [] };
    }

    const ops = await this.getSessionStoreOps();
    const contentLayer = new OverlayContentLayer(getSessionDocsContentRoot(), getContentRoot());
    const rawMarkdown = this.reconstructFullMarkdown(fragmentKey, 0, "");
    await ops.writeRawFragment(this.docPath, this.rawFragmentFileForSectionFile(sectionFile), rawMarkdown);

    const ref = new SectionRef(this.docPath, headingPath);
    const result = this.fragmentIsOrphanOnly(fragmentKey, headingPath)
      ? await contentLayer.upsertSectionMergingToPrevious(ref, rawMarkdown)
      : await (() => {
          const parsed = parseDocumentMarkdown(rawMarkdown);
          const firstHeaded = parsed.find((sec) => !(sec.level === 0 && sec.heading === ""));
          const heading = headingPath.length === 0
            ? ""
            : (firstHeaded?.heading ?? headingPath[headingPath.length - 1] ?? "");
          return contentLayer.upsertSection(ref, heading, rawMarkdown, { contentIsFullMarkdown: true });
        })();

    await this.applyDetailedUpsertResult(
      result,
      contentLayer,
      ops,
      opts,
    );

    return {
      // "changed" reflects ANY material change to the document — structural
      // mutation OR a body-only write/orphan absorption from the stable-
      // target dispatch path. The narrower `structureChange !== null`
      // signal misses the latter and would surface clean orphan-absorption
      // edits as no-ops to the caller.
      changed:
        result.structureChange !== null
        || result.writtenEntries.length > 0
        || result.removedEntries.length > 0,
      createdKeys: result.structureChange
        ? result.structureChange.newEntries
            .map((entry) => DocumentFragments.fragmentKeyFor(entry))
            .filter((key) => key !== fragmentKey)
        : [],
      removedKeys: result.removedEntries.map((entry) => DocumentFragments.fragmentKeyFor(entry)),
    };
  }

  /** Resolve a FlatEntry for a fragment key, or null if not found. */
  resolveEntryForFragmentKey(fragmentKey: string): FlatEntry | null {
    const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
    if (!headingPath) return null;

    const fullMarkdown = this.extractMarkdown(fragmentKey);
    const parsed = parseDocumentMarkdown(fullMarkdown);
    const firstRealSection = parsed.find((section) => section.headingPath.length > 0);
    const sectionFile = this.sectionFileByFragmentKey.get(fragmentKey);
    if (!sectionFile) return null;

    return {
      headingPath: [...headingPath],
      heading: headingPath.length === 0
        ? ""
        : (firstRealSection?.heading ?? headingPath[headingPath.length - 1] ?? ""),
      level: headingPath.length === 0
        ? 0
        : (firstRealSection?.level ?? Math.max(1, headingPath.length)),
      sectionFile,
      absolutePath: "",
      isSubSkeleton: false,
    };
  }

  /** Extract markdown from a Y.Doc fragment. */
  private extractMarkdown(fragmentKey: string): FragmentContent {
    const pmJson = yDocToProsemirrorJSON(this.ydoc, fragmentKey);
    return fragmentFromRemark(jsonToMarkdown(pmJson as Record<string, unknown>));
  }

  /** Clear all content from a Y.Doc fragment.
   *  Pass origin (e.g. SERVER_INJECTION_ORIGIN) to stamp the transaction source. */
  private clearFragment(fragmentKey: string, origin?: unknown): void {
    this.ydoc.transact(() => {
      const fragment = this.ydoc.getXmlFragment(fragmentKey);
      while (fragment.length > 0) {
        fragment.delete(0, 1);
      }
    }, origin);
  }

  /** Populate a Y.Doc fragment from markdown content (heading+body for non-root, body for root).
   *  Pass origin (e.g. SERVER_INJECTION_ORIGIN) to stamp the transaction source.
   *  PRIVATE — always call setFragmentContent instead, which clears first.
   *  Y.applyUpdate merges — calling this on a non-empty fragment duplicates content. */
  private populateFragment(fragmentKey: string, markdown: FragmentContent, origin?: unknown): void {
    const pmJson = markdownToJSON(markdown);
    const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
    Y.applyUpdate(this.ydoc, Y.encodeStateAsUpdate(tempDoc), origin);
    tempDoc.destroy();
  }

  /**
   * Atomically replace a Y.Doc fragment's content: clear existing content then populate.
   * This is the only safe way to set fragment content — Y.applyUpdate merges rather than
   * replaces, so calling populateFragment on a non-empty fragment duplicates content.
   * Pass origin (e.g. SERVER_INJECTION_ORIGIN) to stamp the transaction source.
   */
  setFragmentContent(fragmentKey: string, markdown: FragmentContent, origin?: unknown): void {
    this.clearFragment(fragmentKey, origin);
    this.populateFragment(fragmentKey, markdown, origin);
  }

  /**
   * Replace exactly one fragment's live content from caller-provided fragment content.
   *
   * This is the explicit public API for "I have already chosen the source and built
   * the fragment content; now apply it." It owns ONLY the Y.Doc fragment replacement
   * mechanics — no disk lookup, no source-selection policy, no orphan scan, no
   * recovery decision. Callers are responsible for resolving the runtime source
   * (overlay / canonical / raw fragment / live editor / proposal) and converting
   * it to FragmentContent (heading + body for non-root, body for root).
   *
   * Pass `opts.origin` (e.g. SERVER_INJECTION_ORIGIN) to stamp the transaction
   * source so the afterTransaction guard suppresses dirty-tracking attribution.
   */
  replaceFragmentFromProvidedContent(
    fragmentKey: string,
    content: FragmentContent,
    opts?: { origin?: unknown },
  ): void {
    this.setFragmentContent(fragmentKey, content, opts?.origin);
  }

  /**
   * Replace many fragments at once from a caller-provided map of fragmentKey →
   * FragmentContent. Like the single-fragment variant, this method is policy-free:
   * the caller has already chosen which fragments to replace and what content
   * each one should hold. DocumentFragments only applies the updates.
   *
   * Implementation note: rather than N separate transactions, all clears happen
   * in one transaction and all populations are merged into a single
   * `Y.applyUpdate` call. This is the same batch-population pattern the old
   * `fromDisk` startup path used, kept here so startup/runtime callers can do
   * one explicit multi-fragment apply step.
   */
  replaceFragmentsFromProvidedContent(
    map: Map<string, FragmentContent>,
    opts?: { origin?: unknown },
  ): void {
    if (map.size === 0) return;

    // Phase 1: clear all target fragments in one transaction so partial state
    // is never visible.
    this.ydoc.transact(() => {
      for (const fragmentKey of map.keys()) {
        const fragment = this.ydoc.getXmlFragment(fragmentKey);
        while (fragment.length > 0) {
          fragment.delete(0, 1);
        }
      }
    }, opts?.origin);

    // Phase 2: build all updates from caller content, merge, and apply in one shot.
    const pendingUpdates: Uint8Array[] = [];
    for (const [fragmentKey, content] of map) {
      const pmJson = markdownToJSON(content);
      const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
      pendingUpdates.push(Y.encodeStateAsUpdate(tempDoc));
      tempDoc.destroy();
    }
    if (pendingUpdates.length > 0) {
      const merged = Y.mergeUpdates(pendingUpdates);
      Y.applyUpdate(this.ydoc, merged, opts?.origin);
    }
  }

  /**
   * Build full fragment content (heading+body) for populating a non-root Y.Doc fragment.
   * Root fragments pass body directly (no heading to prepend).
   */
  static buildFragmentContent(body: SectionBody, level: number, heading: string): FragmentContent {
    return buildFragmentContentFn(body, level, heading);
  }

  /**
   * Extract full markdown (heading + body) from the Y.Doc fragment.
   * Fragments already store heading+body, so this is just extractMarkdown().
   * Root fragments (level=0, heading="") have body only — returned as-is.
   */
  private reconstructFullMarkdown(fragmentKey: string, _level: number, _heading: string): FragmentContent {
    return this.extractMarkdown(fragmentKey);
  }

  private async applyDetailedUpsertResult(
    result: UpsertSectionFromMarkdownDetailedResult,
    contentLayer: OverlayContentLayer,
    ops: SessionStoreOps,
    opts?: {
      broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void;
    },
  ): Promise<void> {
    await this.reconcileLiveFragmentsFromDetailedResult(result, contentLayer, ops);
    if (result.structureChange !== null) {
      // Structural mutations land on the OverlayContentLayer's own writable
      // skeleton (a fresh `mutableFromDisk` instance) and are flushed to
      // overlay disk. Our cached `this.skeleton` is now stale — read methods
      // like `expectBeforeFirstHeading()` would observe pre-mutation state
      // (e.g. an auto-created BFH would be invisible). Re-read from overlay
      // disk and rebuild the fragment indices from the new skeleton.
      // `fragmentKeyRemaps` alone is insufficient: it only tells us "key X
      // became key Y", not the new SkeletonNode tree shape or newly-
      // materialized body-holder/BFH entries.
      for (const removed of result.removedEntries) {
        this.dirtyKeys.delete(DocumentFragments.fragmentKeyFor(removed));
      }
      this.skeleton = await DocumentSkeletonInternal.mutableFromDisk(
        this.docPath,
        getSessionDocsContentRoot(),
        getContentRoot(),
      );
      this.rebuildIndexFromSkeleton();
    } else {
      this.applyDetailedUpsertResultToIndex(null, result);
    }
    if (!opts?.broadcastStructureChange || !result.structureChange) return;

    opts.broadcastStructureChange([{
      oldKey: DocumentFragments.fragmentKeyFor(result.structureChange.oldEntry),
      newKeys: result.structureChange.newEntries.map((entry) => DocumentFragments.fragmentKeyFor(entry)),
    }]);
  }

  private rebuildIndexFromSkeleton(): void {
    this.fragmentKeyByHeadingPathKey.clear();
    this.headingPathByFragmentKey.clear();
    this.sectionFileByFragmentKey.clear();
    this.orderedFragmentKeys = [];

    this.skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
      this.upsertIndexEntry({
        heading,
        level,
        sectionFile,
        headingPath: [...headingPath],
        absolutePath,
        isSubSkeleton: false,
      });
      this.orderedFragmentKeys.push(
        fragmentKeyFromSectionFile(sectionFile, DocumentFragments.isBeforeFirstHeading({ headingPath })),
      );
    });
  }

  private applyDetailedUpsertResultToIndex(
    sourceFragmentKey: string | null,
    result: UpsertSectionFromMarkdownDetailedResult,
  ): void {
    const previousOrder = [...this.orderedFragmentKeys];
    const previousKeySet = new Set(previousOrder);
    const removedKeys = result.removedEntries.map((entry) => DocumentFragments.fragmentKeyFor(entry));
    const removedKeySet = new Set(removedKeys);
    const firstRemovedIndex = removedKeys
      .map((key) => previousOrder.indexOf(key))
      .filter((idx) => idx >= 0)
      .sort((a, b) => a - b)[0];

    const newEntries = result.writtenEntries.filter((entry) => {
      const key = DocumentFragments.fragmentKeyFor(entry);
      return removedKeySet.has(key) || !previousKeySet.has(key);
    });
    const newNonBfhKeys = newEntries
      .filter((entry) => entry.headingPath.length > 0)
      .map((entry) => DocumentFragments.fragmentKeyFor(entry));
    const newBfhKeys = newEntries
      .filter((entry) => entry.headingPath.length === 0)
      .map((entry) => DocumentFragments.fragmentKeyFor(entry));

    this.orderedFragmentKeys = previousOrder.filter((key) => !removedKeySet.has(key));

    if (newNonBfhKeys.length > 0) {
      const insertionIndex = firstRemovedIndex !== undefined
        ? firstRemovedIndex
        : (() => {
            const sourceIndex = sourceFragmentKey === null
              ? -1
              : this.orderedFragmentKeys.indexOf(sourceFragmentKey);
            return sourceIndex >= 0 ? sourceIndex + 1 : this.orderedFragmentKeys.length;
          })();
      this.orderedFragmentKeys.splice(insertionIndex, 0, ...newNonBfhKeys);
    }
    if (newBfhKeys.length > 0) {
      this.orderedFragmentKeys.unshift(...newBfhKeys);
    }

    for (const fragmentKey of removedKeys) {
      this.removeIndexEntry(fragmentKey);
      this.dirtyKeys.delete(fragmentKey);
    }
    for (const entry of result.writtenEntries) {
      this.upsertIndexEntry(entry);
    }
  }

  private upsertIndexEntry(entry: FlatEntry): void {
    if (entry.isSubSkeleton) return;

    const fragmentKey = DocumentFragments.fragmentKeyFor(entry);
    const headingPath = [...entry.headingPath];
    const existingHeadingPath = this.headingPathByFragmentKey.get(fragmentKey);
    if (existingHeadingPath) {
      this.fragmentKeyByHeadingPathKey.delete(SectionRef.headingKey(existingHeadingPath));
    }

    this.headingPathByFragmentKey.set(fragmentKey, headingPath);
    this.fragmentKeyByHeadingPathKey.set(SectionRef.headingKey(headingPath), fragmentKey);
    this.sectionFileByFragmentKey.set(fragmentKey, entry.sectionFile);
  }

  private removeIndexEntry(fragmentKey: string): void {
    const headingPath = this.headingPathByFragmentKey.get(fragmentKey);
    if (headingPath) {
      this.fragmentKeyByHeadingPathKey.delete(SectionRef.headingKey(headingPath));
    }
    this.headingPathByFragmentKey.delete(fragmentKey);
    this.sectionFileByFragmentKey.delete(fragmentKey);
  }

  private async reconcileLiveFragmentsFromDetailedResult(
    result: UpsertSectionFromMarkdownDetailedResult,
    contentLayer: OverlayContentLayer,
    ops: SessionStoreOps,
  ): Promise<void> {
    if (result.liveReloadEntries.length === 0 && result.removedEntries.length === 0) {
      return;
    }

    const reloadMap = new Map<string, FragmentContent>();
    for (const entry of result.liveReloadEntries) {
      const body = await contentLayer.readSection(new SectionRef(this.docPath, entry.headingPath));
      const content = entry.headingPath.length === 0
        ? bodyAsFragment(body)
        : DocumentFragments.buildFragmentContent(body, entry.level, entry.heading);
      const fragmentKey = DocumentFragments.fragmentKeyFor(entry);
      reloadMap.set(fragmentKey, content);
    }

    for (const entry of result.removedEntries) {
      await ops.deleteRawFragment(this.docPath, this.rawFragmentFileForSectionFile(entry.sectionFile));
    }
    for (const entry of result.liveReloadEntries) {
      const fragmentKey = DocumentFragments.fragmentKeyFor(entry);
      const content = reloadMap.get(fragmentKey);
      if (content) {
        await ops.writeRawFragment(this.docPath, this.rawFragmentFileForSectionFile(entry.sectionFile), content);
      }
    }

    this.replaceAndDeleteFragmentsFromProvidedContent(
      reloadMap,
      result.removedEntries.map((entry) => DocumentFragments.fragmentKeyFor(entry)),
      { origin: SERVER_INJECTION_ORIGIN },
    );
  }

  private replaceAndDeleteFragmentsFromProvidedContent(
    map: Map<string, FragmentContent>,
    deleteKeys: string[],
    opts?: { origin?: unknown },
  ): void {
    const keysToClear = new Set<string>([...deleteKeys, ...map.keys()]);
    if (keysToClear.size === 0) return;

    this.ydoc.transact(() => {
      for (const fragmentKey of keysToClear) {
        const fragment = this.ydoc.getXmlFragment(fragmentKey);
        while (fragment.length > 0) {
          fragment.delete(0, 1);
        }
      }
    }, opts?.origin);

    const pendingUpdates: Uint8Array[] = [];
    for (const [fragmentKey, content] of map) {
      const pmJson = markdownToJSON(content);
      const tempDoc = prosemirrorJSONToYDoc(getBackendSchema(), pmJson, fragmentKey);
      pendingUpdates.push(Y.encodeStateAsUpdate(tempDoc));
      tempDoc.destroy();
    }
    if (pendingUpdates.length > 0) {
      const merged = Y.mergeUpdates(pendingUpdates);
      Y.applyUpdate(this.ydoc, merged, opts?.origin);
    }
  }

  private rawFragmentFileForSectionFile(sectionFile: string): string {
    return sectionFile.endsWith(".md") ? sectionFile : `${sectionFile}.md`;
  }


  /**
   * Lazy-resolved session-store operations. Avoids circular dependency
   * (session-store imports from ydoc-lifecycle which imports document-fragments).
   */
  private _sessionStoreOps: SessionStoreOps | null = null;
  private async getSessionStoreOps(): Promise<SessionStoreOps> {
    if (!this._sessionStoreOps) {
      const mod = await import("../storage/session-store.js");
      this._sessionStoreOps = {
        writeRawFragment: mod.writeRawFragment,
        deleteRawFragment: mod.deleteRawFragment,
      };
    }
    return this._sessionStoreOps;
  }

}

/** Resolved session-store operations, passed through to avoid per-method imports. */
interface SessionStoreOps {
  writeRawFragment: (docPath: string, sectionFile: string, content: FragmentContent | string) => Promise<void>;
  deleteRawFragment: (docPath: string, sectionFile: string) => Promise<void>;
}
