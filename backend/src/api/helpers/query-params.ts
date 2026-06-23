/**
 * Typed Express query-parameter helpers.
 *
 * `req.query` values are `string | string[] | ParsedQs | ParsedQs[] | undefined`
 * (Express parses `?a=1&a=2` into an array and `?a[b]=1` into a nested object).
 * These helpers replace scattered `req.query.x as string` assertions with explicit
 * single-value modelling: a list/object query value is REJECTED with a 400-shaped
 * `QueryParamError` rather than silently coerced. A `QueryParamError` thrown from a
 * route should be surfaced as `sendApiError(res, 400, error)`.
 */
import type { Request } from "express";

/** The value type of a single `req.query[key]` entry, derived from Express's own types. */
type QueryParamValue = Request["query"][string];

/** A client supplied an unusable query parameter (a list/object where a scalar was expected). */
export class QueryParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryParamError";
  }
}

/**
 * Reject array/object query values. A single string or an absent value passes
 * through; a repeated param (`?x=1&x=2`) or a nested object (`?x[y]=1`) throws.
 */
function rejectNonScalar(value: QueryParamValue, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    throw new QueryParamError(`Query parameter "${name}" must be a single value, not a list.`);
  }
  throw new QueryParamError(`Query parameter "${name}" must be a string, not a nested object.`);
}

/**
 * Single optional string. Returns `undefined` when the parameter is absent;
 * rejects arrays/objects.
 */
export function optionalStringParam(value: QueryParamValue, name: string): string | undefined {
  return rejectNonScalar(value, name);
}

/**
 * Required single string. Throws `QueryParamError` when the parameter is absent,
 * empty, or not a single string.
 */
export function requiredStringParam(value: QueryParamValue, name: string): string {
  const scalar = rejectNonScalar(value, name);
  if (scalar === undefined || scalar.length === 0) {
    throw new QueryParamError(`Query parameter "${name}" is required.`);
  }
  return scalar;
}

/**
 * Bounded integer. An absent or unparseable value falls back to `fallback`; the
 * result is clamped to `[min, max]`. Arrays/objects are rejected. Mirrors the
 * prior `Math.min(Math.max(parseInt(x) || fallback, min), max)` route idiom while
 * refusing structured query values.
 */
export function boundedIntParam(
  value: QueryParamValue,
  name: string,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number {
  const scalar = rejectNonScalar(value, name);
  const base = (scalar !== undefined ? parseInt(scalar, 10) : NaN) || fallback;
  return Math.min(Math.max(base, min), max);
}
