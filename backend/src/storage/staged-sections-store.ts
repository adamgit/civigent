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

import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "../crdt/ydoc-fragments.js";
import type { LiveFragmentStringsStore, StructuralChange } from "../crdt/live-fragment-strings-store.js";
import { getContentRoot, getSessionSectionsContentRoot } from "./data-root.js";
import { parseDocumentMarkdown } from "./markdown-sections.js";
import { OverlayContentLayer, type UpsertSectionFromMarkdownDetailedResult } from "./content-layer.js";
import { DocumentSkeletonInternal, type FlatEntry } from "./document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";
import {
  bodyAsFragment,
  buildFragmentContent,
  type FragmentContent,
} from "./section-formatting.js";

/**
 * Return shape of `acceptLiveFragments`. Carries enough information for
 * `DocSession.applyAcceptResult` to (conditionally) reconcile the live
 * Y.Doc and rebuild its heading-path index without touching disk.
 *
 * - `acceptedKeys`   — fragment keys whose live content was successfully
 *                      written to the staging area and cleared from
 *                      `liveStore.aheadOfStagedKeys`.
 * - `structuralChange` — non-null iff a split/merge/rename/relocation/BFH/
 *                      subtree-rewrite occurred. Consumer passes it to
 *                      `liveFragments.applyStructuralChange`.
 * - `remaps`         — `{ oldKey, newKeys[] }` entries for client broadcast
 *                      so editors can unmount/remount against new keys.
 * - `updatedIndex`   — full ordered `fragmentKey ↔ headingPath` mapping
 *                      after a structural mutation. Non-null iff
 *                      `structuralChange` is non-null.
 * - `writtenKeys`    — fragment keys whose overlay body content was
 *                      (re)written. Used by the transitional wrapper to
 *                      report `encodeSessionOverlayImported(writtenKeys, ...)`.
 * - `deletedKeys`    — fragment keys removed during this accept. Superset
 *                      of `structuralChange?.removedKeys` (empty when
 *                      structuralChange is null).
 */
export interface AcceptResult {
  acceptedKeys: ReadonlySet<string>;
  structuralChange: StructuralChange | null;
  remaps: Array<{ oldKey: string; newKeys: string[] }>;
  updatedIndex: ReadonlyArray<{ fragmentKey: string; headingPath: string[] }> | null;
  writtenKeys: ReadonlyArray<string>;
  deletedKeys: ReadonlyArray<string>;
}

export class StagedSectionsStore {
  readonly docPath: string;

  /**
   * Filesystem path exposed for `CanonicalStore.absorbChangedSections` to
   * read staged content during a commit. This is the shared session-sections
   * content root (contains `<docPath>.md` + `<docPath>.sections/` layout for
   * every active session doc); callers scope absorb to this document via
   * `opts.docPaths: [this.docPath]`.
   */
  readonly stagingRoot: string;

  private readonly aheadOfCanonicalRefs = new Set<string>();

  /**
   * Promise-chain serializing `acceptLiveFragments` calls on this store.
   * `acceptLiveFragments` is a multi-step async op (read skeleton, yield,
   * upsert, yield, re-read skeleton, ...). Concurrent callers on the same
   * instance would interleave skeleton/body writes and corrupt disk state.
   * Each call chains behind the previous one so the next call runs against
   * fresh disk state. The chain recovers from thrown errors via `.catch`.
   */
  private _acceptChain: Promise<unknown> = Promise.resolve();

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
   * 4. Accumulates `writtenEntries`, `removedEntries`, `liveReloadEntries`,
   *    and per-upsert `structureChanges` across all processed keys.
   * 5. After all upserts: if any live-reloads or removals were recorded,
   *    reads post-overlay body content for each live-reload key and packages
   *    everything into a `StructuralChange` the caller can hand to
   *    `liveFragments.applyStructuralChange(...)`.
   * 6. Clears accepted keys from `liveStore.aheadOfStagedKeys` and records
   *    them in `aheadOfCanonicalRefs`.
   *
   * This method does NOT touch the live Y.Doc, does NOT write raw recovery
   * files, and does NOT broadcast. Those are the caller's responsibilities
   * (the raw snapshot runs before accept; `applyAcceptResult` runs after).
   */
  acceptLiveFragments(
    liveStore: LiveFragmentStringsStore,
    scope: ReadonlySet<string> | "all",
  ): Promise<AcceptResult> {
    const next = this._acceptChain.then(() => this._acceptLiveFragmentsImpl(liveStore, scope));
    this._acceptChain = next.catch(() => {});
    return next;
  }

  private async _acceptLiveFragmentsImpl(
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
        structuralChange: null,
        remaps: [],
        updatedIndex: null,
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
    const liveReloadKeySet = new Set<string>();
    const remaps: Array<{ oldKey: string; newKeys: string[] }> = [];

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
          }
          for (const live of bootstrapResult.liveReloadEntries) {
            const liveKey = fragmentKeyFromSectionFile(
              live.sectionFile,
              live.headingPath.length === 0,
            );
            liveReloadKeySet.add(liveKey);
          }
          for (const removed of bootstrapResult.removedEntries) {
            const removedKey = fragmentKeyFromSectionFile(
              removed.sectionFile,
              removed.headingPath.length === 0,
            );
            removedKeySet.add(removedKey);
            writtenKeySet.delete(removedKey);
            liveReloadKeySet.delete(removedKey);
            accepted.add(removedKey);
          }
          for (const sc of bootstrapResult.structureChanges) {
            const oldKey = fragmentKeyFromSectionFile(
              sc.oldEntry.sectionFile,
              sc.oldEntry.headingPath.length === 0,
            );
            const newKeys = sc.newEntries.map((e) =>
              fragmentKeyFromSectionFile(e.sectionFile, e.headingPath.length === 0),
            );
            remaps.push({ oldKey, newKeys });
          }

          await refreshSkeletonView();
          entry = indexByKey.get(fragmentKey);
          if (!entry) {
            throw new Error(
              `Empty-doc BFH bootstrap for "${this.docPath}" did not materialize the BFH section — skeleton index still missing "${fragmentKey}" after upsert.`,
            );
          }
          return;
        }

        // Skeleton no longer has this key (a prior upsert in this same
        // accept-call already absorbed/removed it). Silent skip matches
        // the legacy behaviour of `importDirtyFragmentsToSessionOverlay`.
        return;
      }
      const headingPath = entry.headingPath;
      const rawMarkdown = liveStore.readFragmentString(fragmentKey);

      // Orphan predecessor convergence (BUG2-followup-C). When the current
      // fragment is orphan-only (user deleted its heading in the CRDT),
      // recursively pre-normalize any orphan-only predecessor chain so the
      // disk-level merge in `deleteSectionAndAbsorbOrphanBody` never clobbers
      // a predecessor's pending heading deletion.
      if (isOrphanOnly(headingPath, rawMarkdown)) {
        while (true) {
          const idx = orderedKeys.indexOf(fragmentKey);
          if (idx <= 0) break;
          const predKey = orderedKeys[idx - 1];
          const predEntry = indexByKey.get(predKey);
          if (!predEntry) break;
          const predContent = liveStore.readFragmentString(predKey);
          if (!isOrphanOnly(predEntry.headingPath, predContent)) break;
          // Only treat predecessor as orphan-only if it was actually dirty
          // (user modified it). Unmodified body-holder fragments are
          // naturally body-only — their orphan-only shape does NOT indicate
          // heading deletion. Without this check, the loop would
          // incorrectly collapse every parent body-holder predecessor.
          if (!aheadOfStaged.has(predKey)) break;
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
      if (isOrphanOnly(headingPath, rawMarkdown)) {
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
        liveReloadKeySet.delete(removedKey);
        accepted.add(removedKey);
      }
      for (const written of result.writtenEntries) {
        const writtenKey = fragmentKeyFromSectionFile(
          written.sectionFile,
          written.headingPath.length === 0,
        );
        writtenKeySet.add(writtenKey);
      }
      for (const live of result.liveReloadEntries) {
        const liveKey = fragmentKeyFromSectionFile(
          live.sectionFile,
          live.headingPath.length === 0,
        );
        liveReloadKeySet.add(liveKey);
      }

      for (const sc of result.structureChanges) {
        const oldKey = fragmentKeyFromSectionFile(
          sc.oldEntry.sectionFile,
          sc.oldEntry.headingPath.length === 0,
        );
        const newKeys = sc.newEntries.map((e) =>
          fragmentKeyFromSectionFile(e.sectionFile, e.headingPath.length === 0),
        );
        remaps.push({ oldKey, newKeys });
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

    // Decide whether a structural change is needed.
    const hasStructural = liveReloadKeySet.size > 0 || removedKeySet.size > 0;

    let structuralChange: StructuralChange | null = null;
    let updatedIndex: Array<{ fragmentKey: string; headingPath: string[] }> | null = null;

    if (hasStructural) {
      const contentByKey = new Map<string, FragmentContent>();
      for (const key of liveReloadKeySet) {
        const entry = indexByKey.get(key);
        if (!entry) {
          // A live-reload key that the final skeleton no longer has means
          // a subsequent upsert removed it. Drop it from contentByKey and
          // make sure it's surfaced as removed instead.
          removedKeySet.add(key);
          continue;
        }
        const body = await contentLayer.readSection(new SectionRef(this.docPath, entry.headingPath));
        const content = entry.headingPath.length === 0
          ? bodyAsFragment(body)
          : buildFragmentContent(body, entry.level, entry.heading);
        contentByKey.set(key, content);
      }
      structuralChange = {
        orderedKeys: [...orderedKeys],
        contentByKey,
        removedKeys: new Set(removedKeySet),
      };
      updatedIndex = orderedKeys.map((k) => {
        const e = indexByKey.get(k)!;
        return { fragmentKey: k, headingPath: [...e.headingPath] };
      });
    }

    liveStore.clearAheadOfStaged(accepted);
    for (const key of accepted) {
      this.aheadOfCanonicalRefs.add(key);
    }

    return {
      acceptedKeys: accepted,
      structuralChange,
      remaps,
      updatedIndex,
      writtenKeys: [...writtenKeySet],
      deletedKeys: [...removedKeySet],
    };
  }

  // ─── Boundary-3 tracking (staged → canonical) ────────────────────

  /**
   * Mark a section ref (opaque string key — typically a fragment key or a
   * heading-path key, depending on what the delegate passes in) as having
   * staged content that has not yet been committed to canonical. Called by
   * `acceptLiveFragments` for every accepted key, and also directly by
   * proposal/import paths that stage content outside the live session.
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

  // ─── Structural cleanliness check (debounced-flush gating) ───────

  /**
   * Cheap structural-shape check for the debounced flush path. Returns true
   * when the fragment's live content parses to exactly the expected shape
   * for its fragment key:
   *
   *   - BFH (`section::__beforeFirstHeading__`): zero top-level headings
   *   - headed fragment: exactly one top-level heading, matching the
   *     expected level (1–6)
   *
   * When the check returns true, `acceptLiveFragments` is guaranteed to
   * take the body-only fast path — no split, merge, relocation, or BFH
   * handling. Callers use this to skip overlay writes for structurally-
   * dirty fragments, deferring normalization to an explicit trigger
   * (focus change, publish, session end).
   *
   * IMPORTANT: this does not detect the orphan-only case (user deleted a
   * section's heading, leaving body content only). Orphan detection
   * requires knowing the fragment's expected heading path, which is owned
   * by `DocSession` during the transition. Callers that care about
   * orphan-only behavior (debounced flush) should additionally consult
   * the session's own orphan check until the native `acceptLiveFragments`
   * implementation subsumes both.
   */
  isStructurallyClean(
    liveStore: LiveFragmentStringsStore,
    fragmentKey: string,
  ): boolean {
    const content = liveStore.readFragmentString(fragmentKey);
    const parsed = parseDocumentMarkdown(content);

    if (fragmentKey === BEFORE_FIRST_HEADING_KEY) {
      // BFH: body-only, no headings. parseDocumentMarkdown represents a
      // headingless body as a single level-0 empty-heading entry.
      if (parsed.length === 0) return true;
      if (parsed.length === 1 && parsed[0].level === 0 && parsed[0].heading === "") return true;
      return false;
    }

    // Headed fragment: exactly one top-level heading entry. A fragment
    // with > 1 top-level heading is a split-in-progress. A fragment with
    // 0 headings is an orphan (heading deleted).
    const topLevelHeadings = parsed.filter((sec) => !(sec.level === 0 && sec.heading === ""));
    return topLevelHeadings.length === 1;
  }
}

/**
 * A fragment is "orphan-only" when its CRDT content parses to a single
 * level-0 orphan with non-empty body AND it is not the BFH (headingPath=[])
 * — i.e. the user deleted the section's heading, leaving only body content.
 * `acceptLiveFragments` detects this to (a) dispatch to the orphan-absorb
 * upsert path and (b) drive the predecessor-convergence chain.
 */
function isOrphanOnly(headingPath: string[], content: string): boolean {
  if (headingPath.length === 0) return false;
  if (!content) return false;
  const parsed = parseDocumentMarkdown(content);
  if (parsed.length !== 1) return false;
  const only = parsed[0];
  if (only.level !== 0 || only.heading !== "") return false;
  return (only.body as unknown as string).trim().length > 0;
}
