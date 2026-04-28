/**
 * StagedSectionsStore — backend boundary 2 receiver (live → staged)
 *
 * Owns `sessions/sections/content/` skeleton + body files for a single
 * document. Canonical-shaped staging area that `CanonicalStore` reads from
 * during absorb. The single normalization choke point for the session
 * pipeline: all split/merge/rename/relocation/BFH/subtree-rewrite happens
 * inside `acceptLiveFragments`.
 *
 * No external code reads or writes individual sections or skeletons through
 * this store — the only write path during normal operation is
 * `acceptLiveFragments`, and the only read consumer is
 * `CanonicalStore.absorbChangedSections`, which reads via `stagingRoot`.
 *
 * Internally uses `OverlayContentLayer` for skeleton and body-file I/O.
 * That is an implementation detail — callers interact with boundary methods
 * only.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import {
  BEFORE_FIRST_HEADING_KEY,
  fragmentKeyFromSectionFile,
} from "../crdt/ydoc-fragments.js";
import type { LiveFragmentStringsStore } from "../crdt/live-fragment-strings-store.js";
import { getContentRoot, getSessionSectionsContentRoot } from "./data-root.js";
import { parseDocumentMarkdown } from "./markdown-sections.js";
import { OverlayContentLayer, type UpsertSectionFromMarkdownDetailedResult } from "./content-layer.js";
import { DocumentSkeletonInternal, type FlatEntry } from "./document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";
import { classifyFragmentDrift } from "./fragment-drift.js";
import type { SectionRefReceipt } from "./canonical-store.js";

/**
 * Return shape of `acceptLiveFragments`. Describes only the overlay-side
 * accept result; it is not a live Y.Doc rewrite contract.
 *
 * - `acceptedKeys`   — fragment keys whose caller-provided live content was
 *                      successfully written to the staging area. These are the
 *                      runtime fragment identities that remain ahead of
 *                      canonical until a later absorb clears them.
 * - `writtenKeys`    — fragment keys whose overlay body content was
 *                      (re)written. Used by the transitional wrapper to
 *                      report `encodeSessionOverlayImported(writtenKeys, ...)`.
 * - `deletedKeys`    — fragment keys removed during this accept.
 */
export interface AcceptResult {
  acceptedKeys: ReadonlySet<string>;
  writtenKeys: ReadonlyArray<string>;
  deletedKeys: ReadonlyArray<string>;
  writtenSectionRefs?: ReadonlyArray<SectionRefReceipt>;
  deletedSectionRefs?: ReadonlyArray<SectionRefReceipt>;
}

export interface SettleResult extends AcceptResult {
  staleOverlay: boolean;
}

export class StagedSectionsStore {
  readonly docPath: string;

  /**
   * Filesystem path exposed for `CanonicalStore.absorbChangedSections` to
   * read staged content during a commit. This is the shared session-sections
   * content root (contains `<docPath>.md` + `<docPath>.sections/` layout for
   * every active session doc); callers scope absorb to this document via
   * `opts.documentPathsToRewrite: [this.docPath]`.
   */
  readonly stagingRoot: string;

  private readonly aheadOfCanonicalRefs = new Set<string>();

  constructor(docPath: string) {
    this.docPath = docPath;
    this.stagingRoot = getSessionSectionsContentRoot();
  }

  // ─── Boundary-2 inbound (live → staged) ──────────────────────────

  /**
   * Accept live fragment content into the staging area. The single
   * normalization choke point for the session pipeline:
   *
   * 1. Loads the current skeleton from disk and builds a fragment-key ↔
   *    FlatEntry index plus a document-order fragment-key list.
   * 2. For every in-scope key (in document order): reads live content from
   *    `liveStore.readFragmentString(key)`, detects the orphan-only heading-
   *    deleted case, recursively pre-normalizes any orphan-only predecessor
   *    chain (convergence invariant — see BUG2-followup-C), and dispatches
   *    to `OverlayContentLayer.upsertSectionMergingToPrevious` (orphan) or
   *    `OverlayContentLayer.upsertSection` (structurally-clean or embedded-
   *    heading split) for the actual disk write.
   * 3. After any upsert that mutates the skeleton, re-reads the skeleton
   *    from disk so the next iteration's predecessor chain and heading-
   *    path lookups observe the updated structure.
   * 4. Accumulates overlay-written and overlay-deleted fragment keys across
   *    all processed keys.
   * 5. Records accepted keys in `aheadOfCanonicalRefs`.
   *
   * This method does NOT touch the live Y.Doc, does NOT write raw recovery
   * files, and does NOT broadcast. Those are the caller's responsibilities
   * (the raw snapshot runs before accept; `applyAcceptResult` runs after).
   */
  async acceptLiveFragments(
    liveStore: LiveFragmentStringsStore,
    scope: ReadonlySet<string> | "all",
  ): Promise<AcceptResult> {
    const aheadOfStaged = liveStore.getAheadOfStagedKeys();
    const resolvedScope = scope === "all"
      ? new Set(aheadOfStaged)
      : new Set([...scope].filter((key) => aheadOfStaged.has(key)));

    if (resolvedScope.size === 0) {
      return {
        acceptedKeys: new Set(),
        writtenKeys: [],
        deletedKeys: [],
      };
    }

    const contentLayer = new OverlayContentLayer(
      getSessionSectionsContentRoot(),
      getContentRoot(),
    );

    // Load the initial skeleton view. This is re-read after every upsert
    // that mutates structure so the next iteration observes the new shape.
    let indexByKey = new Map<string, FlatEntry>();
    let orderedKeys: string[] = [];
    const refreshSkeletonView = async (): Promise<void> => {
      const skeleton = await DocumentSkeletonInternal.mutableFromDisk(
        this.docPath,
        getSessionSectionsContentRoot(),
        getContentRoot(),
      );
      const nextIndex = new Map<string, FlatEntry>();
      const nextOrdered: string[] = [];
      skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
        const isBfh = headingPath.length === 0;
        const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBfh);
        nextIndex.set(fragmentKey, {
          heading,
          level,
          sectionFile,
          headingPath: [...headingPath],
          absolutePath,
          isSubSkeleton: false,
        });
        nextOrdered.push(fragmentKey);
      });
      indexByKey = nextIndex;
      orderedKeys = nextOrdered;
    };

    await refreshSkeletonView();

    // Accumulators for the final AcceptResult.
    const accepted = new Set<string>();
    const writtenKeySet = new Set<string>();
    const removedKeySet = new Set<string>();
    const writtenSectionRefMap = new Map<string, SectionRefReceipt>();
    const deletedSectionRefMap = new Map<string, SectionRefReceipt>();
    const noteSectionRef = (
      target: Map<string, SectionRefReceipt>,
      headingPath: string[],
    ): void => {
      const headingKey = SectionRef.headingKey(headingPath);
      target.set(headingKey, { docPath: this.docPath, headingPath: [...headingPath] });
    };

    const processKey = async (fragmentKey: string): Promise<void> => {
      let entry = indexByKey.get(fragmentKey);
      if (!entry) {
        // Empty-document BFH bootstrap: when the whole skeleton is empty
        // and the scope names the synthetic BFH key, materialize it by
        // upserting the root section. Strictly gated so no non-BFH key
        // and no non-empty skeleton can take this path.
        if (
          fragmentKey === BEFORE_FIRST_HEADING_KEY
          && indexByKey.size === 0
          && orderedKeys.length === 0
        ) {
          const bootstrapMarkdown = liveStore.readFragmentString(fragmentKey);
          const bootstrapRef = new SectionRef(this.docPath, []);
          const bootstrapResult = await contentLayer.upsertSection(
            bootstrapRef,
            "",
            bootstrapMarkdown,
            { contentIsFullMarkdown: true },
          );

          accepted.add(fragmentKey);
          for (const written of bootstrapResult.writtenEntries) {
            const writtenKey = fragmentKeyFromSectionFile(
              written.sectionFile,
              written.headingPath.length === 0,
            );
            writtenKeySet.add(writtenKey);
            noteSectionRef(writtenSectionRefMap, written.headingPath);
          }
          for (const live of bootstrapResult.liveReloadEntries) {
            const liveKey = fragmentKeyFromSectionFile(
              live.sectionFile,
              live.headingPath.length === 0,
            );
            writtenKeySet.add(liveKey);
            noteSectionRef(writtenSectionRefMap, live.headingPath);
          }
          for (const removed of bootstrapResult.removedEntries) {
            const removedKey = fragmentKeyFromSectionFile(
              removed.sectionFile,
              removed.headingPath.length === 0,
            );
            removedKeySet.add(removedKey);
            writtenKeySet.delete(removedKey);
            accepted.add(removedKey);
            noteSectionRef(deletedSectionRefMap, removed.headingPath);
          }

          // Two sub-cases, both already fully described by the upsert's
          // writtenEntries/removedEntries that the loops above accumulated:
          //   A) live BFH had BFH-only body → BFH section materialized on
          //      disk (skeleton now has BFH entry).
          //   B) live BFH began with `# X\n...` (user typed headings into
          //      an empty doc) → upsert split into headed sections, wrote
          //      no BFH entry, and emitted the BFH removal as its structure
          //      change so removedKeySet has BFH and writtenKeySet has the
          //      headed keys.
          await refreshSkeletonView();
          return;
        }

        // Skeleton no longer has this key (a prior upsert in this same
        // accept-call already absorbed/removed it). Silent skip matches
        // the legacy behaviour of `importDirtyFragmentsToSessionOverlay`.
        return;
      }
      const headingPath = entry.headingPath;
      const rawMarkdown = liveStore.readFragmentString(fragmentKey);
      const drift = classifyFragmentDrift({
        fragmentKey,
        headingPath,
        markdown: rawMarkdown,
        isAheadOfStaged: aheadOfStaged.has(fragmentKey),
      });

      // Orphan predecessor convergence (BUG2-followup-C). When the current
      // fragment is orphan-only (user deleted its heading in the CRDT),
      // recursively pre-normalize any orphan-only predecessor chain so the
      // disk-level merge in `deleteSectionAndAbsorbOrphanBody` never clobbers
      // a predecessor's pending heading deletion.
      if (drift.orphanOnly) {
        while (true) {
          const idx = orderedKeys.indexOf(fragmentKey);
          if (idx <= 0) break;
          const predKey = orderedKeys[idx - 1];
          const predEntry = indexByKey.get(predKey);
          if (!predEntry) break;
          const predContent = liveStore.readFragmentString(predKey);
          const predecessorDrift = classifyFragmentDrift({
            fragmentKey: predKey,
            headingPath: predEntry.headingPath,
            markdown: predContent,
            isAheadOfStaged: aheadOfStaged.has(predKey),
          });
          if (!predecessorDrift.orphanOnly) break;
          // Only treat predecessor as orphan-only if it was actually dirty
          // (user modified it). Unmodified body-holder fragments are
          // naturally body-only — their orphan-only shape does NOT indicate
          // heading deletion. Without this check, the loop would
          // incorrectly collapse every parent body-holder predecessor.
          if (
            predecessorDrift.state === "clean"
            || predecessorDrift.state === "structural-dirty"
          ) break;
          // Recursive call — processes the predecessor regardless of scope
          // membership. Each recursion absorbs predKey into its own merge
          // target and reloads the skeleton view so the next iteration
          // observes the new immediate predecessor.
          await processKey(predKey);
        }
      }

      // After predecessor convergence, the skeleton may have been
      // restructured (e.g. a parent heading collapsed, promoting this
      // fragment to a new headingPath). Re-fetch from the index so the
      // SectionRef uses the current headingPath, not the stale one
      // captured before the loop.
      const refreshedEntry = indexByKey.get(fragmentKey);
      if (!refreshedEntry) return;

      const ref = new SectionRef(this.docPath, refreshedEntry.headingPath);
      let result: UpsertSectionFromMarkdownDetailedResult;
      if (drift.orphanOnly) {
        result = await contentLayer.upsertSectionMergingToPrevious(ref, rawMarkdown);
      } else {
        const parsed = parseDocumentMarkdown(rawMarkdown);
        const firstHeaded = parsed.find((sec) => !(sec.level === 0 && sec.heading === ""));
        const heading = headingPath.length === 0
          ? ""
          : (firstHeaded?.heading ?? headingPath[headingPath.length - 1] ?? "");
        result = await contentLayer.upsertSection(ref, heading, rawMarkdown, {
          contentIsFullMarkdown: true,
        });
      }

      accepted.add(fragmentKey);

      for (const removed of result.removedEntries) {
        const removedKey = fragmentKeyFromSectionFile(
          removed.sectionFile,
          removed.headingPath.length === 0,
        );
        removedKeySet.add(removedKey);
        // If a write earlier in this accept call later got removed (e.g.
        // predecessor orphan absorbed), the write-then-remove nets to
        // "removed" — keep writtenKeys aligned with the final state by
        // dropping the earlier write.
        writtenKeySet.delete(removedKey);
        accepted.add(removedKey);
        noteSectionRef(deletedSectionRefMap, removed.headingPath);
      }
      for (const written of result.writtenEntries) {
        const writtenKey = fragmentKeyFromSectionFile(
          written.sectionFile,
          written.headingPath.length === 0,
        );
        writtenKeySet.add(writtenKey);
        noteSectionRef(writtenSectionRefMap, written.headingPath);
      }
      for (const live of result.liveReloadEntries) {
        const liveKey = fragmentKeyFromSectionFile(
          live.sectionFile,
          live.headingPath.length === 0,
        );
        writtenKeySet.add(liveKey);
        noteSectionRef(writtenSectionRefMap, live.headingPath);
      }

      // If this upsert mutated structure (or added/removed entries), reload
      // the skeleton view so subsequent iterations see the new shape.
      if (
        result.structureChanges.length > 0
        || result.removedEntries.length > 0
        || result.writtenEntries.length > 0
      ) {
        await refreshSkeletonView();
      }
    };

    // Process scope in the skeleton's document order — keys not present in
    // the skeleton go at the end (rare: a key in aheadOfStaged that the
    // skeleton has never seen). This matches the legacy dirty-flush
    // iteration while also keeping sequential-matrix convergence stable.
    const scopeList = orderedKeys.filter((k) => resolvedScope.has(k));
    for (const key of resolvedScope) {
      if (!scopeList.includes(key)) scopeList.push(key);
    }
    for (const key of scopeList) {
      await processKey(key);
    }

    for (const key of accepted) {
      this.aheadOfCanonicalRefs.add(key);
    }

    return {
      acceptedKeys: accepted,
      writtenKeys: [...writtenKeySet],
      deletedKeys: [...removedKeySet],
      writtenSectionRefs: [...writtenSectionRefMap.values()],
      deletedSectionRefs: [...deletedSectionRefMap.values()],
    };
  }

  // ─── Boundary-3 tracking (staged → canonical) ────────────────────

  /**
   * Mark a fragment-scoped runtime ref as having staged content that has not
   * yet been committed to canonical. Ordinary session runtime uses fragment
   * keys here; document-rooted cleanup is intentionally not modeled.
   */
  noteAheadOfCanonical(sectionRef: string): void {
    this.aheadOfCanonicalRefs.add(sectionRef);
  }

  isAheadOfCanonical(sectionRef: string): boolean {
    return this.aheadOfCanonicalRefs.has(sectionRef);
  }

  getAheadOfCanonicalRefs(): ReadonlySet<string> {
    return this.aheadOfCanonicalRefs;
  }

  /**
   * Clear section refs from the ahead-of-canonical set. Called after a
   * successful `CanonicalStore.absorbChangedSections` commit to record that
   * the sections are no longer ahead.
   *
   * Pass `"all"` to clear the entire set (publish of every dirty section,
   * session end, restore pre-commit).
   */
  clearAheadOfCanonical(sectionRefs: Iterable<string> | "all"): void {
    if (sectionRefs === "all") {
      this.aheadOfCanonicalRefs.clear();
      return;
    }
    for (const ref of sectionRefs) {
      this.aheadOfCanonicalRefs.delete(ref);
    }
  }

  /**
   * Ordinary post-absorb cleanup is fragment-scoped. We clear only the
   * absorbed runtime refs; document-rooted overlay teardown remains reserved
   * for reset/teardown paths.
   */
  applyAbsorbedFragmentCleanup(fragmentKeys: Iterable<string>): void {
    this.clearAheadOfCanonical(fragmentKeys);
  }

  /**
   * Restore-only hard reset for this document's staged overlay files.
   */
  async _resetForDocPath(): Promise<void> {
    await this.clearOverlayForDocPath();
    this.clearAheadOfCanonical("all");
  }

  private async clearOverlayForDocPath(): Promise<void> {
    const normalized = normalizeDocPath(this.docPath);
    const skeletonPath = path.resolve(this.stagingRoot, ...normalized.split("/"));
    await rm(skeletonPath, { force: true });
    await rm(`${skeletonPath}.sections`, { recursive: true, force: true });
  }

}

function normalizeDocPath(docPath: string): string {
  return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
}
