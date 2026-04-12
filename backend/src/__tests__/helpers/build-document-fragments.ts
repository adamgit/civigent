/**
 * Test helper: build a DocSession-like object from disk for use in tests.
 *
 * Replicates the construction sequence from `acquireDocSession(...)` in
 * `ydoc-lifecycle.ts` but returns a minimal `TestDocSession` that tests
 * can use to exercise the store boundary pipeline (liveFragments,
 * recoveryBuffer, stagedSections, heading-path index).
 *
 * This helper lives OUTSIDE production code on purpose: it builds the
 * runtime state for test fixtures, not for production sessions. Production
 * sessions go through `acquireDocSession(...)`.
 */

import * as Y from "yjs";
import { getContentRoot, getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { DocumentSkeletonInternal } from "../../storage/document-skeleton.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { LiveFragmentStringsStore, SERVER_INJECTION_ORIGIN } from "../../crdt/live-fragment-strings-store.js";
import { StagedSectionsStore } from "../../storage/staged-sections-store.js";
import {
  EMPTY_BODY,
  buildFragmentContent,
  fragmentFromDisk,
  type FragmentContent,
} from "../../storage/section-formatting.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { SectionRef } from "../../domain/section-ref.js";
import { applyAcceptResult, type DocSession } from "../../crdt/ydoc-lifecycle.js";

/**
 * Minimal DocSession for testing. Contains the fields needed by
 * store boundary operations and the applyAcceptResult orchestrator.
 */
export type TestDocSession = Pick<
  DocSession,
  | "ydoc"
  | "liveFragments"
  | "recoveryBuffer"
  | "stagedSections"
  | "docPath"
  | "headingPathByFragmentKey"
  | "fragmentKeyByHeadingPathKey"
  | "orderedFragmentKeys"
  | "perUserDirty"
  | "fragmentFirstActivity"
  | "fragmentLastActivity"
>;

/**
 * Build a test session from disk. Mirrors the `acquireDocSession` construction:
 *
 *   1. Load skeleton from overlay → canonical
 *   2. Read raw fragment files (crash-safe) and overlay/canonical body content
 *   3. Construct LiveFragmentStringsStore, RawFragmentRecoveryBuffer, StagedSectionsStore
 *   4. Build bidirectional heading-path index from skeleton walk
 *   5. Bulk-apply content via replaceFragmentStrings
 *   6. Normalize sections sourced from raw fragments
 */
export async function buildDocumentFragmentsForTest(docPath: string): Promise<TestDocSession> {
  const canonicalRoot = getContentRoot();
  const overlayRoot = getSessionSectionsContentRoot();
  const overlay = new OverlayContentLayer(overlayRoot, canonicalRoot);

  const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, overlayRoot, canonicalRoot);
  const ydoc = new Y.Doc();

  // Build ordered keys + bidirectional index from skeleton walk
  const orderedKeys: string[] = [];
  const headingPathByFragmentKey = new Map<string, string[]>();
  const fragmentKeyByHeadingPathKey = new Map<string, string>();
  skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
    const isBfh = headingPath.length === 0;
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBfh);
    orderedKeys.push(fragmentKey);
    const hp = [...headingPath];
    headingPathByFragmentKey.set(fragmentKey, hp);
    fragmentKeyByHeadingPathKey.set(SectionRef.headingKey(hp), fragmentKey);
  });

  const liveStrings = new LiveFragmentStringsStore(ydoc, orderedKeys, docPath);
  const rawRecovery = new RawFragmentRecoveryBuffer(docPath);
  const stagedSections = new StagedSectionsStore(docPath);

  const session: TestDocSession = {
    ydoc,
    liveFragments: liveStrings,
    recoveryBuffer: rawRecovery,
    stagedSections,
    docPath,
    headingPathByFragmentKey,
    fragmentKeyByHeadingPathKey,
    orderedFragmentKeys: orderedKeys,
    perUserDirty: new Map(),
    fragmentFirstActivity: new Map(),
    fragmentLastActivity: new Map(),
  };

  if (!skeleton.areSkeletonRootsEmpty) {
    // Read raw fragment files (crash-safe, take precedence)
    const rawFragmentKeys = await rawRecovery.listFragmentKeys();
    const rawKeySet = new Set(rawFragmentKeys);
    const rawContentMap = new Map<string, string>();
    for (const rawKey of rawFragmentKeys) {
      const content = await rawRecovery.readFragment(rawKey);
      if (content !== null) rawContentMap.set(rawKey, content);
    }

    const bulkContent = await overlay.readAllSections(docPath);

    const contentMap = new Map<string, FragmentContent>();
    const rawSourcedKeys: string[] = [];

    skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      const isBfh = headingPath.length === 0;
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBfh);

      if (rawKeySet.has(fragmentKey)) {
        contentMap.set(fragmentKey, fragmentFromDisk(rawContentMap.get(fragmentKey) ?? ""));
        rawSourcedKeys.push(fragmentKey);
      } else {
        const headingKey = SectionRef.headingKey([...headingPath]);
        const bodyContent = bulkContent?.get(headingKey) ?? EMPTY_BODY;
        contentMap.set(fragmentKey, buildFragmentContent(bodyContent, level, heading));
      }
    });

    liveStrings.replaceFragmentStrings(contentMap, SERVER_INJECTION_ORIGIN);

    // Normalize sections sourced from raw fragments
    for (const fragmentKey of rawSourcedKeys) {
      liveStrings.noteAheadOfStaged(fragmentKey);
      const scope = new Set<string>([fragmentKey]);
      await rawRecovery.writeFragment(fragmentKey, liveStrings.readFragmentString(fragmentKey));
      const acceptResult = await stagedSections.acceptLiveFragments(liveStrings, scope);
      await applyAcceptResult(session as DocSession, acceptResult);
    }
  }

  return session;
}

// Re-export for tests that need it
export { SERVER_INJECTION_ORIGIN };
export type { FragmentContent };
