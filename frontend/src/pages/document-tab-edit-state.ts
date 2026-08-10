/**
 * Tab-title edit signals for the focused live document page.
 * Kept as named predicates so the INTENT of each comparison stays obvious and
 * easy to revise without hunting call sites.
 */

/** Shared-draft unpublished changes: live authority is up and the bound proposal has claimed sections. */
export function hasUnpublishedChangesOnThisPage(
  isCurrentlyLiveAuthority: boolean,
  changedSectionCount: number,
): boolean {
  return isCurrentlyLiveAuthority && changedSectionCount > 0;
}

/**
 * In-flight edits (not the shared-draft claim set): local pending work and/or
 * edits not yet acknowledged (`!allReceived`).
 */
export function hasInFlightEditsOnThisPage(
  allReceived: boolean,
  hasLocalUncommittedEdits: boolean,
): boolean {
  return !allReceived || hasLocalUncommittedEdits;
}
