/**
 * Typed error taxonomy for DocumentSkeleton/DocumentSkeletonInternal operations.
 *
 * The two top-level categories serve different caller intents:
 *
 * - StaleReferenceError: the caller passed a heading path / fragment key /
 *   section file id that does not (or no longer) resolves in the current
 *   skeleton. The skeleton itself is well-formed; the *reference* is stale.
 *   Examples: a CRDT writer flushes against a fragment key whose owning
 *   section was deleted by another writer; a heading was renamed between
 *   the time the caller looked it up and the time it asked to mutate it.
 *   These are recoverable from the caller's perspective — they typically
 *   warrant a re-resolve, a no-op, or a re-target rather than a crash.
 *
 * - SkeletonIntegrityError: the on-disk skeleton tree itself is internally
 *   inconsistent — a sub-skeleton missing its body holder, duplicate roots,
 *   a body file referenced from the skeleton but absent from the active
 *   layer, etc. These are NOT recoverable from the caller's perspective
 *   and indicate data corruption that needs operator/recovery intervention.
 *
 * Both classes carry the docPath and an optional headingPath/fragmentKey/
 * sectionFileId for diagnostics. The base class identity is what callers
 * pattern-match on; the cause/details fields are for logging.
 *
 * NOTE per project error policy: these classes never swallow stack traces.
 * The constructors only annotate; they never log or hide the underlying
 * cause. Callers that catch one of these MUST either re-throw or surface
 * the full message in their response.
 */

export interface SkeletonErrorContext {
  docPath: string;
  headingPath?: readonly string[];
  fragmentKey?: string;
  sectionFileId?: string;
}

abstract class SkeletonError extends Error {
  readonly docPath: string;
  readonly headingPath?: readonly string[];
  readonly fragmentKey?: string;
  readonly sectionFileId?: string;

  constructor(message: string, ctx: SkeletonErrorContext, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.docPath = ctx.docPath;
    this.headingPath = ctx.headingPath;
    this.fragmentKey = ctx.fragmentKey;
    this.sectionFileId = ctx.sectionFileId;
  }
}

/**
 * The reference (heading path / fragment key / section file id) does not
 * resolve in the current skeleton. The skeleton itself is consistent; the
 * caller's reference is stale or never existed.
 *
 * This is the recoverable category — callers may retry with a re-resolved
 * reference, no-op, or re-target.
 */
export class StaleReferenceError extends SkeletonError {}

/**
 * The skeleton tree itself is in a state that violates the structural
 * invariants (duplicate roots, dangling sub-skeleton body holders, body
 * file present in skeleton but missing on disk in the active layer, etc).
 *
 * This is the non-recoverable category — operator intervention required.
 */
export class SkeletonIntegrityError extends SkeletonError {}

/**
 * Convenience constructors used at the most common throw sites. Each
 * embeds the structural context into the message so log lines stay
 * useful even after the typed fields are stripped.
 */

export function staleHeadingPath(
  docPath: string,
  headingPath: readonly string[],
  detail?: string,
): StaleReferenceError {
  const suffix = detail ? ` — ${detail}` : "";
  return new StaleReferenceError(
    `Heading path [${headingPath.join(" > ")}] not found in ${docPath}${suffix}`,
    { docPath, headingPath },
  );
}

export function staleFragmentKey(
  docPath: string,
  fragmentKey: string,
  detail?: string,
): StaleReferenceError {
  const suffix = detail ? ` — ${detail}` : "";
  return new StaleReferenceError(
    `Fragment key "${fragmentKey}" not found in ${docPath}${suffix}`,
    { docPath, fragmentKey },
  );
}

export function staleSectionFileId(
  docPath: string,
  sectionFileId: string,
  detail?: string,
): StaleReferenceError {
  const suffix = detail ? ` — ${detail}` : "";
  return new StaleReferenceError(
    `Section file "${sectionFileId}" not found in ${docPath}${suffix}`,
    { docPath, sectionFileId },
  );
}

export function skeletonIntegrity(
  docPath: string,
  detail: string,
  ctx?: Omit<SkeletonErrorContext, "docPath">,
): SkeletonIntegrityError {
  return new SkeletonIntegrityError(
    `Skeleton integrity error in ${docPath}: ${detail}`,
    { docPath, ...ctx },
  );
}
