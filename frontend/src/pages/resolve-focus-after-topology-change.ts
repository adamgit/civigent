/**
 * `resolveFocusAfterTopologyChange` — the ONE pure focus-handoff rule for live
 * pages (frontend live-document design). Focus is PAGE state held as a
 * `SectionId` (never an index, never replica state); the render index is derived
 * from `getTopology()`. Because section identity is stable across splits / merges
 * / reorders, a focused section that merely moves is followed by identity lookup
 * — no follow logic. The only real logic is REMOVAL handoff, encoded here.
 *
 * This fully replaces `adoptFreshSectionLayout`'s index-based focus reconciliation
 * (including the BFH-dissolve and no-predecessor→BFH special cases). The page runs
 * it on the replica `subscribe` when topology identity/order changed, keying off
 * `getTopology()` alone — the live update frame applies the structural Yjs update
 * and its resulting topology before notifying, so focus never reconciles against
 * half a structural fact.
 */

import type { SectionId, LiveSectionRef } from "../types/live-sections";
import { BEFORE_FIRST_HEADING_SECTION_ID } from "../types/live-sections";

/**
 * Given the previous and next topology and the currently-focused id, return the
 * id that should hold focus after the topology change (or null).
 *
 * Rules:
 *   - caretOwningId provided and present     → it wins (caret recovery moved the
 *                                              author's caret there; "id still
 *                                              present" must not clobber it);
 *   - focused id still present               → keep it;
 *   - gone, was BFH                          → first headed section, else null;
 *   - gone, was first (no predecessor)       → BFH if present, else first
 *                                              remaining, else null;
 *   - gone, non-first                        → predecessor if present, else the
 *                                              section now in that slot, else null.
 */
export function resolveFocusAfterTopologyChange(
  prev: readonly LiveSectionRef[],
  next: readonly LiveSectionRef[],
  focusedId: SectionId | null,
  caretOwningId?: SectionId | null,
): SectionId | null {
  const nextIds = new Set(next.map((r) => r.id));
  if (caretOwningId != null && nextIds.has(caretOwningId)) return caretOwningId;

  if (focusedId === null) return null;

  // Still present → identity is stable across moves; keep focus, no follow logic.
  if (nextIds.has(focusedId)) return focusedId;

  const firstHeaded = (): SectionId | null =>
    next.find((r) => r.headingPath.length > 0)?.id ?? null;

  // Focused id was BFH and it dissolved → hand off to the first headed section.
  if (focusedId === BEFORE_FIRST_HEADING_SECTION_ID) return firstHeaded();

  const prevIndex = prev.findIndex((r) => r.id === focusedId);
  // Focused id was not in prev either (never present / already gone) → clear.
  if (prevIndex < 0) return null;

  if (prevIndex === 0) {
    // The document's FIRST section (no predecessor) was removed — no-predecessor
    // heading-deletion folds into BFH, or dissolves it. Hand off to BFH if it was
    // created, else the first remaining section, else null.
    if (nextIds.has(BEFORE_FIRST_HEADING_SECTION_ID)) return BEFORE_FIRST_HEADING_SECTION_ID;
    return next[0]?.id ?? null;
  }

  // Non-first section removed (predecessor merge / mid-doc delete): follow the
  // merge survivor (its predecessor) if still present, else the section now
  // occupying the removed slot, else null.
  const predecessorId = prev[prevIndex - 1].id;
  if (nextIds.has(predecessorId)) return predecessorId;
  if (next.length > 0) return next[Math.min(prevIndex, next.length - 1)].id;
  return null;
}
