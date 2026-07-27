/**
 * Live-section delta computation — the MW-3 canonical→live compute/apply closure
 * the DocSession actor feeds into the generator's shared `Y.transact` primitive
 * (`applyCanonicalDeltaToLive`).
 *
 * Layering: this module lives in `crdt/*` and reads only storage + section
 * layout. It NEVER imports the coordinator. The coordinator (or the DocSession
 * actor) calls these to build the `computeDelta` (runs OUTSIDE the Y.transact)
 * and `applyDelta` (runs INSIDE) pair, then hands them to the generator which
 * owns the transaction discipline + optimistic-concurrency retry.
 *
 * MW-3 canonical→live: read the COMMITTED canonical body for a changed section,
 * build its fragment form, and write it into the live fragment when it differs
 * from what the live Y.Doc currently holds. Returns null when the live fragment
 * already reflects the committed content.
 *
 * NOTE: the live→canonical-FORM normalization that used to live here
 * (`computeNormalizationDelta`) and the layout set-diff
 * (`computeLiveStructuralReconcile`) are GONE — both clobbered Yjs struct
 * identity (clear+recreate) and forced live→canonical. They are replaced by the
 * identity-preserving classifier-driven appliers in `crdt/structural-appliers.ts`
 * (wired into `runQuiescenceCommand`).
 */

import { buildFragmentContent, type FragmentContent } from "../storage/section-formatting.js";
import { SectionRef } from "../domain/section-ref.js";
import { resolveLiveSectionLayout, type LiveSectionLayoutEntry } from "./live-section-layout.js";
import type { LiveFragmentStringsStore } from "./live-fragment-strings-store.js";
import type { ProposalId } from "../types/shared.js";
import type { DocPath } from "../types/shared.js";

/** A precomputed live-fragment delta: write `content` into `fragmentKey`. */
export interface FragmentStringDelta {
  fragmentKey: string;
  content: FragmentContent;
}


/**
 * Apply a precomputed fragment-string delta into the live Y.Doc. Runs INSIDE
 * the generator's `Y.transact`. The `origin` tags the write as server-authored
 * so the adapter's touched-fragment listener / client observers can distinguish
 * it from a client edit.
 */
export function applyFragmentStringDelta(
  liveFragments: LiveFragmentStringsStore,
  delta: FragmentStringDelta,
  origin: unknown,
): void {
  liveFragments.replaceFragmentString(delta.fragmentKey, delta.content, origin);
}

/**
 * Compute the canonical→live delta for the changed sections of a committed
 * proposal. For each changed section heading path that maps to a live fragment,
 * read the COMMITTED canonical body and build its fragment form; include it only
 * when it differs from the live Y.Doc's current fragment content.
 *
 * `affectedFragmentKeys` (out param population) and the returned deltas share
 * the same key set, so the caller can pass the keys to the generator's
 * pre-flight clock check.
 */
export async function computeCanonicalToLiveDeltas(
  liveFragments: LiveFragmentStringsStore,
  docPath: DocPath,
  currentProposalId: ProposalId | null,
  changedHeadingPaths: readonly string[][],
): Promise<{ deltas: FragmentStringDelta[]; fragmentKeys: string[] }> {
  const { ContentLayer } = await import("../storage/content-layer.js");
  const { getContentRoot } = await import("../storage/data-root.js");

  const layout = await resolveLiveSectionLayout(docPath, currentProposalId);
  const byHeadingKey = new Map<string, LiveSectionLayoutEntry>();
  for (const entry of layout) {
    byHeadingKey.set(SectionRef.headingKey(entry.headingPath), entry);
  }

  const canonical = new ContentLayer(getContentRoot());
  const deltas: FragmentStringDelta[] = [];
  const fragmentKeys: string[] = [];

  for (const headingPath of changedHeadingPaths) {
    const entry = byHeadingKey.get(SectionRef.headingKey(headingPath));
    if (!entry) continue; // changed section has no live fragment identity — skip.

    let body;
    try {
      body = await canonical.readSection(new SectionRef(docPath, [...headingPath]));
    } catch {
      // Section absent from canonical (e.g. deleted) — nothing to apply here.
      continue;
    }
    const fragmentContent = buildFragmentContent(body, entry.level, entry.heading);
    const current = liveFragments.readFragmentString(entry.fragmentKey);
    if (fragmentContent === current) continue;

    deltas.push({ fragmentKey: entry.fragmentKey, content: fragmentContent });
    fragmentKeys.push(entry.fragmentKey);
  }

  return { deltas, fragmentKeys };
}
