/**
 * Section-shape predicates — the SINGLE place in the codebase allowed to test
 * `(level === 0 && heading === "")` directly. All other code must call one of
 * these named predicates so the discriminator can later be hardened (e.g. a
 * dedicated `storageRole` field on `FlatEntry`/`ContentEntry`) by changing only
 * the predicate bodies, with no caller-side rewrites.
 *
 * The four predicates each name a distinct INTENT, so callers don't have to
 * re-derive which equivalence applies to their site:
 *
 *   - isBodyHolderShape:           pure shape test; use inside DocumentSkeleton
 *                                  internals where the shape IS the structural
 *                                  signal (mutation, persistence, flat-walk
 *                                  classification). Does not distinguish
 *                                  document-level BFH from sub-skeleton body
 *                                  holders — those are visible-read concerns.
 *
 *   - isDocumentBeforeFirstHeading: true document-level BFH (the anonymous
 *                                  pre-heading content for the whole doc).
 *                                  Use in visible read paths that skip the
 *                                  heading line ONLY for the document BFH —
 *                                  assembly, `prependHeadings`, git-history
 *                                  assembly, snapshot rendering.
 *
 *   - isNestedBodyHolder:          sub-skeleton body holder (parentPath > 0).
 *                                  Use in the visible-section traversal to
 *                                  fold the entry's metadata onto its parent.
 *
 *   - parsedSectionIsHeadless:     parser-output shape test — "this parsed
 *                                  fragment carries no heading line". Same
 *                                  test as `isBodyHolderShape` today, but
 *                                  named for the parser-classification intent
 *                                  so if parser shape and skeleton shape ever
 *                                  diverge, this predicate is the single
 *                                  point of change.
 */

export interface BodyHolderShapeInput {
  readonly heading: string;
  readonly level: number;
}

export interface BodyHolderEntryInput extends BodyHolderShapeInput {
  readonly headingPath: readonly string[];
}

export function isBodyHolderShape(node: BodyHolderShapeInput): boolean {
  return node.level === 0 && node.heading === "";
}

export function isDocumentBeforeFirstHeading(entry: BodyHolderEntryInput): boolean {
  return isBodyHolderShape(entry) && entry.headingPath.length === 0;
}

export function isNestedBodyHolder(entry: BodyHolderEntryInput): boolean {
  return isBodyHolderShape(entry) && entry.headingPath.length > 0;
}

export function parsedSectionIsHeadless(section: BodyHolderShapeInput): boolean {
  return isBodyHolderShape(section);
}
