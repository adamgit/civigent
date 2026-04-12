/**
 * Test helper: build a `DocumentFragments` from disk via the explicit
 * construction sequence used by `acquireDocSession(...)`.
 *
 * Background: prior to items 331-347, tests called `FragmentStore.fromDisk(docPath)`
 * which loaded the skeleton, scanned for orphaned bodies, and constructed the
 * fragment store in one self-loading factory call. Item 333 deleted that factory
 * because the runtime layer was treating the fragment owner as a self-loading
 * object. Item 347 (this helper) gives tests an explicit way to assemble the
 * runtime state — same source-precedence policy `acquireDocSession` uses
 * (raw fragments first, then overlay/canonical body) — without bringing back the
 * deleted self-loading factory and without inlining ~30 lines of construction
 * code in every test file.
 *
 * This helper lives OUTSIDE the production class on purpose: it builds the
 * runtime state for test fixtures, not for production sessions. Production
 * sessions go through `acquireDocSession(...)` in `ydoc-lifecycle.ts`.
 */

import * as Y from "yjs";
import { getContentRoot, getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { DocumentFragments } from "../../crdt/document-fragments.js";
import { DocumentSkeletonInternal } from "../../storage/document-skeleton.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { listRawFragments, readRawFragment } from "../../storage/session-store.js";
import {
  EMPTY_BODY,
  fragmentFromDisk,
  type FragmentContent,
} from "../../storage/section-formatting.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { SectionRef } from "../../domain/section-ref.js";

/**
 * Assemble a `DocumentFragments` for the given document by replicating the
 * explicit construction sequence in `acquireDocSession(...)`:
 *
 *   1. Load the mutable skeleton from overlay → canonical
 *   2. Read raw fragment files (sessions/fragments/) and overlay/canonical
 *      body content
 *   3. Construct `DocumentFragments` via the public constructor
 *   4. Bulk-apply the chosen content via `replaceFragmentsFromProvidedContent`
 *   5. Normalize sections that came from raw fragments
 *
 * This deliberately does NOT perform any orphan scan, recovery decision,
 * or self-healing — those concerns belong to the server-start crash recovery
 * pipeline (`storage/crash-recovery.ts`), not to fragment ownership.
 */
export async function buildDocumentFragmentsForTest(docPath: string): Promise<DocumentFragments> {
  const canonicalRoot = getContentRoot();
  const overlayRoot = getSessionSectionsContentRoot();
  const overlay = new OverlayContentLayer(overlayRoot, canonicalRoot);

  const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, overlayRoot, canonicalRoot);
  const ydoc = new Y.Doc();
  const fragments = new DocumentFragments(ydoc, skeleton, docPath);

  if (skeleton.areSkeletonRootsEmpty) return fragments;

  const rawFiles = await listRawFragments(docPath);
  const rawFileSet = new Set(rawFiles);
  const rawContentMap = new Map<string, string>();
  for (const rawFile of rawFiles) {
    const content = await readRawFragment(docPath, rawFile);
    if (content !== null) rawContentMap.set(rawFile, content);
  }

  const bulkContent = await overlay.readAllSections(docPath);

  const contentMap = new Map<string, FragmentContent>();
  const rawSourcedKeys: string[] = [];

  skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    const isBfh = DocumentFragments.isBeforeFirstHeading({ headingPath, level, heading });
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBfh);

    if (rawFileSet.has(sectionFile)) {
      contentMap.set(fragmentKey, fragmentFromDisk(rawContentMap.get(sectionFile) ?? ""));
      rawSourcedKeys.push(fragmentKey);
    } else {
      const headingKey = SectionRef.headingKey([...headingPath]);
      const bodyContent = bulkContent?.get(headingKey) ?? EMPTY_BODY;
      contentMap.set(fragmentKey, DocumentFragments.buildFragmentContent(bodyContent, level, heading));
    }
  });

  fragments.replaceFragmentsFromProvidedContent(contentMap);

  for (const fragmentKey of rawSourcedKeys) {
    await fragments.normalizeStructure(fragmentKey);
  }

  return fragments;
}
