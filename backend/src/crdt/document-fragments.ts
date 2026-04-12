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

import type * as Y from "yjs";
import { DocumentSkeletonInternal, type DocumentSkeleton, type FlatEntry } from "../storage/document-skeleton.js";
import { parseDocumentMarkdown } from "../storage/markdown-sections.js";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getSessionSectionsContentRoot } from "../storage/data-root.js";
import {
  fragmentKeyFromSectionFile,
} from "./ydoc-fragments.js";
import {
  bodyFromParser,
  bodyAsFragment,
  buildFragmentContent as buildFragmentContentFn,
  fragmentAsBody,
  type SectionBody,
  type FragmentContent,
} from "../storage/section-formatting.js";
import {
  LiveFragmentStringsStore,
  SERVER_INJECTION_ORIGIN,
} from "./live-fragment-strings-store.js";
import { RawFragmentRecoveryBuffer } from "../storage/raw-fragment-recovery-buffer.js";
import { StagedSectionsStore, type AcceptResult } from "../storage/staged-sections-store.js";

// Re-exported from live-fragment-strings-store so existing importers of
// DocumentFragments.SERVER_INJECTION_ORIGIN keep working. The authoritative
// definition lives on the new store.
export { SERVER_INJECTION_ORIGIN };

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

  /** Adapter: the new backend-boundary-1 store. During the transition, this
   *  DocumentFragments holds a LiveFragmentStringsStore internally and
   *  delegates all Y.Doc content reads/writes through it. Later refactor
   *  stages will unwrap this adapter entirely. */
  readonly liveStrings: LiveFragmentStringsStore;

  /** Adapter: the new crash-recovery sidecar. Owns sessions/fragments/ I/O.
   *  Not a pipeline stage — writes are for crash safety only. */
  readonly rawRecovery: RawFragmentRecoveryBuffer;

  /** Adapter: the new backend-boundary-2 store. Owns sessions/sections/
   *  staging + boundary-3 tracking. Implements the native
   *  `acceptLiveFragments(liveStore, scope)` entry point from
   *  store-architecture.md. `importDirtyFragmentsToSessionOverlay` and
   *  `normalizeStructure` on this class are now thin wrappers that call
   *  through to the store's native path and apply the returned
   *  `StructuralChange` to `liveStrings` (plus the local index). */
  readonly stagedSections: StagedSectionsStore;

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
    this.liveStrings = new LiveFragmentStringsStore(ydoc, this.orderedFragmentKeys, docPath);
    this.rawRecovery = new RawFragmentRecoveryBuffer(docPath);
    this.stagedSections = new StagedSectionsStore(docPath);
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
   * Transitional wrapper over the native
   * `StagedSectionsStore.acceptLiveFragments(...)` path.
   *
   * Still exposed on DocumentFragments because many callers (production
   * `session-store.ts`, `auto-commit.ts`, and ~40 test sites with
   * monkey-patches) depend on this public method name. When Group C
   * finishes rewiring those callers to `stagedSections.acceptLiveFragments`
   * directly and Group B5 moves the heading-path index onto DocSession,
   * this wrapper will be removed.
   *
   * Steps, mirroring the `store-architecture.md` session-pipeline flow:
   *   1. Intersect the caller's scope with this document's dirty keys and
   *      clear them from `dirtyKeys` (the old boundary-2 tracker). The
   *      native path clears `liveStrings.aheadOfStagedKeys` separately —
   *      this wrapper maintains the legacy `dirtyKeys` mirror for callers
   *      that still read it.
   *   2. Write raw recovery files for every key in scope BEFORE accepting.
   *      This preserves the crash-safety ordering: if the server dies
   *      between the raw write and the overlay write, recovery reads the
   *      raw file.
   *   3. Call `stagedSections.acceptLiveFragments(liveStrings, scope)`.
   *   4. If the result carries a `StructuralChange`, apply it to the live
   *      Y.Doc via `liveStrings.applyStructuralChange(...)` and rebuild
   *      the local heading-path index from `updatedIndex` (plus reload
   *      `this.skeleton` from disk for callers that still read it).
   *   5. For the raw-recovery sidecar: delete raw files for removed
   *      fragment keys and rewrite raw files for fragments whose content
   *      changed as a side-effect of structural reconciliation (keeps the
   *      raw recovery buffer aligned with the current fragment-key set).
   *   6. Invoke `broadcastStructureChange` with the remap list.
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

    // Raw recovery snapshot (pre-accept) — mirrors the per-fragment raw
    // write the legacy path did inside its inner loop.
    const droppedKeys: Array<{ fragmentKey: string; error: unknown }> = [];
    for (const fragmentKey of keysToFlush) {
      const headingPath = this.findHeadingPathForFragmentKey(fragmentKey);
      if (!headingPath) {
        droppedKeys.push({ fragmentKey, error: new Error("fragment key no longer resolves to a heading path") });
        continue;
      }
      const rawMarkdown = this.liveStrings.readFragmentString(fragmentKey);
      await this.rawRecovery.writeFragment(fragmentKey, rawMarkdown);
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

    const acceptResult = await this.stagedSections.acceptLiveFragments(this.liveStrings, keysToFlush);

    await this.applyAcceptResult(acceptResult, opts);

    return {
      writtenKeys: [...acceptResult.writtenKeys],
      deletedKeys: [...acceptResult.deletedKeys],
    };
  }

  /**
   * Thin wrapper over the native `stagedSections.acceptLiveFragments` path
   * for the per-fragment structural normalization triggers (focus change,
   * publish, session end). During the transition, `DocSession`-equivalent
   * orchestration still lives on DocumentFragments, so this method owns:
   *
   *   1. Writing the raw-recovery snapshot before accept.
   *   2. Calling `stagedSections.acceptLiveFragments(liveStrings, { key })`.
   *   3. Applying the returned `AcceptResult` to the live Y.Doc + local
   *      heading-path index via `applyAcceptResult`.
   *   4. Returning a legacy `NormalizeResult` for callers that still
   *      consume `changed/createdKeys/removedKeys`.
   */
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
    const sectionFile = this.sectionFileByFragmentKey.get(fragmentKey);
    if (!sectionFile) {
      return { changed: false, createdKeys: [], removedKeys: [] };
    }

    // Mark the key ahead-of-staged so `acceptLiveFragments` processes it
    // even if there has been no CRDT-level dirty signal yet. The legacy
    // path processed whatever key the caller passed regardless of dirty
    // state, so we need this noop-safe mark to preserve behavior.
    this.liveStrings.noteAheadOfStaged(fragmentKey);

    const rawMarkdown = this.liveStrings.readFragmentString(fragmentKey);
    await this.rawRecovery.writeFragment(fragmentKey, rawMarkdown);

    const scope = new Set<string>([fragmentKey]);
    const acceptResult = await this.stagedSections.acceptLiveFragments(this.liveStrings, scope);

    await this.applyAcceptResult(acceptResult, opts);

    const removedKeys = [...acceptResult.deletedKeys];
    // Callers of `normalizeStructure` expect `createdKeys` to list NEW
    // fragment keys spawned by a structural split, excluding the source
    // key. Derive from the remap chain: every `newKeys` entry whose oldKey
    // is the source fragment contributes here.
    const createdKeys: string[] = [];
    for (const remap of acceptResult.remaps) {
      if (remap.oldKey !== fragmentKey) continue;
      for (const k of remap.newKeys) {
        if (k !== fragmentKey) createdKeys.push(k);
      }
    }

    return {
      changed:
        acceptResult.structuralChange !== null
        || acceptResult.writtenKeys.length > 0
        || acceptResult.deletedKeys.length > 0,
      createdKeys,
      removedKeys,
    };
  }

  /**
   * Apply an `AcceptResult` returned by `stagedSections.acceptLiveFragments`
   * back onto this DocumentFragments instance (transitional): updates the
   * live Y.Doc via `liveStrings.applyStructuralChange`, reloads the local
   * skeleton reference and heading-path index, rewrites raw recovery files
   * for newly-written fragment keys, deletes raw files for removed keys,
   * and invokes the optional structure-change broadcast callback.
   *
   * When `StagedSectionsStore` becomes the pipeline owner and DocSession
   * holds the heading-path index (Group B5 → Group C finish), this logic
   * moves into `DocSession.applyAcceptResult`.
   */
  private async applyAcceptResult(
    result: AcceptResult,
    opts?: {
      broadcastStructureChange?: (info: Array<{ oldKey: string; newKeys: string[] }>) => void;
    },
  ): Promise<void> {
    if (result.structuralChange !== null) {
      // (1) Reconcile the live Y.Doc with the new fragment content.
      this.liveStrings.applyStructuralChange(result.structuralChange);

      // (2) Reload the local skeleton reference. Tests and a handful of
      // production callers still read `fragments.skeleton.forEachSection`
      // directly; until that consumer set is gone, reload from disk so
      // the reference stays in sync with the staging directory.
      this.skeleton = await DocumentSkeletonInternal.mutableFromDisk(
        this.docPath,
        getSessionSectionsContentRoot(),
        getContentRoot(),
      );
      this.rebuildIndexFromSkeleton();

      // (3) Rewrite raw recovery files for fragments whose content changed
      // as a side-effect of structural reconciliation, and delete raw
      // files for removed fragment keys. This mirrors the legacy
      // `reconcileLiveFragmentsFromDetailedResult` behavior so crash
      // recovery sees a raw-file set that matches the current fragment
      // layout.
      for (const removedKey of result.structuralChange.removedKeys) {
        this.dirtyKeys.delete(removedKey);
        await this.rawRecovery.deleteFragment(removedKey);
      }
      for (const [reloadKey, content] of result.structuralChange.contentByKey) {
        await this.rawRecovery.writeFragment(reloadKey, content);
      }
    }

    if (opts?.broadcastStructureChange && result.remaps.length > 0) {
      opts.broadcastStructureChange([...result.remaps]);
    }
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

  /** Extract markdown from a Y.Doc fragment. Delegated to LiveFragmentStringsStore. */
  private extractMarkdown(fragmentKey: string): FragmentContent {
    return this.liveStrings.readFragmentString(fragmentKey);
  }

  /**
   * Atomically replace a Y.Doc fragment's content. Delegated to
   * LiveFragmentStringsStore, which owns the clear+populate mechanics.
   * Pass origin (e.g. SERVER_INJECTION_ORIGIN) to stamp the transaction source.
   */
  setFragmentContent(fragmentKey: string, markdown: FragmentContent, origin?: unknown): void {
    this.liveStrings.replaceFragmentString(fragmentKey, markdown, origin);
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
    this.liveStrings.replaceFragmentStrings(map, opts?.origin);
  }

  /**
   * Build full fragment content (heading+body) for populating a non-root Y.Doc fragment.
   * Root fragments pass body directly (no heading to prepend).
   */
  static buildFragmentContent(body: SectionBody, level: number, heading: string): FragmentContent {
    return buildFragmentContentFn(body, level, heading);
  }

  private rebuildIndexFromSkeleton(): void {
    this.fragmentKeyByHeadingPathKey.clear();
    this.headingPathByFragmentKey.clear();
    this.sectionFileByFragmentKey.clear();
    this.orderedFragmentKeys = [];

    this.skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
      const fragmentKey = fragmentKeyFromSectionFile(
        sectionFile,
        DocumentFragments.isBeforeFirstHeading({ headingPath }),
      );
      const existingHeadingPath = this.headingPathByFragmentKey.get(fragmentKey);
      const existingSectionFile = this.sectionFileByFragmentKey.get(fragmentKey);
      if (existingHeadingPath || existingSectionFile) {
        const existingHeadingLabel = existingHeadingPath && existingHeadingPath.length > 0
          ? existingHeadingPath.join(" > ")
          : "(before first heading)";
        const incomingHeadingLabel = headingPath.length > 0
          ? headingPath.join(" > ")
          : "(before first heading)";
        throw new Error(
          `Duplicate fragment key "${fragmentKey}" in "${this.docPath}": ` +
          `sectionFile "${sectionFile}" for headingPath=[${incomingHeadingLabel}] conflicts with ` +
          `existing sectionFile "${existingSectionFile ?? sectionFile}" for headingPath=[${existingHeadingLabel}].`,
        );
      }
      this.upsertIndexEntry({
        heading,
        level,
        sectionFile,
        headingPath: [...headingPath],
        absolutePath,
        isSubSkeleton: false,
      });
      this.orderedFragmentKeys.push(fragmentKey);
    });
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

}
