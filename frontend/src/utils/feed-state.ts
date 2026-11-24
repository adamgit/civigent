export type Feed<T> =
  | { status: "loading" }
  | { status: "failed"; error: Error }
  | { status: "loaded"; data: T; refreshError: Error | null };

export class CombinedFeedError extends Error {
  readonly errors: readonly Error[];

  constructor(errors: readonly Error[]) {
    super(errors.map((error) => error.message).join("\n"));
    this.name = "CombinedFeedError";
    this.errors = errors;
  }
}

export function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

function mergeErrors(errors: readonly Error[]): Error | null {
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0];
  return new CombinedFeedError(errors);
}

type FeedValues<R> = { [K in keyof R]: R[K] extends Feed<infer T> ? T : never };

export function combineFeeds<R extends Record<string, Feed<unknown>>>(feeds: R): Feed<FeedValues<R>> {
  const entries = Object.entries(feeds);
  const failure = mergeErrors(
    entries.flatMap(([, feed]) => (feed.status === "failed" ? [feed.error] : [])),
  );
  if (failure) return { status: "failed", error: failure };
  if (entries.some(([, feed]) => feed.status === "loading")) return { status: "loading" };
  const data: Record<string, unknown> = {};
  const refreshErrors: Error[] = [];
  for (const [key, feed] of entries) {
    if (feed.status !== "loaded") continue;
    data[key] = feed.data;
    if (feed.refreshError) refreshErrors.push(feed.refreshError);
  }
  return { status: "loaded", data: data as FeedValues<R>, refreshError: mergeErrors(refreshErrors) };
}

export function mapLoadedFeed<T, U>(feed: Feed<T>, project: (data: T) => U): Feed<U> {
  if (feed.status !== "loaded") return feed;
  return { status: "loaded", data: project(feed.data), refreshError: feed.refreshError };
}

export function loadedFeedDataOr<T>(feed: Feed<T>, fallback: T): T {
  return feed.status === "loaded" ? feed.data : fallback;
}

export type OptionalFeedShortfall =
  | { subject: string; state: "loading" }
  | { subject: string; state: "failed"; error: Error };

export interface OptionalFeed<T> {
  subject: string;
  feed: Feed<T>;
  valueWhileUnavailable: T;
}

type OptionalFeedValues<R> = { [K in keyof R]: R[K] extends OptionalFeed<infer T> ? T : never };

export interface FeedWithOptionalExtras<P, E> {
  primary: P;
  extras: E;
  extrasShortfalls: OptionalFeedShortfall[];
}

export function requirePrimaryFeedWithOptionalExtras<P, R extends Record<string, OptionalFeed<unknown>>>(
  primary: Feed<P>,
  optionalExtras: R,
): Feed<FeedWithOptionalExtras<P, OptionalFeedValues<R>>> {
  if (primary.status !== "loaded") return primary;
  const extras: Record<string, unknown> = {};
  const extrasShortfalls: OptionalFeedShortfall[] = [];
  const refreshErrors: Error[] = primary.refreshError ? [primary.refreshError] : [];
  for (const [key, optional] of Object.entries(optionalExtras)) {
    const { feed, subject } = optional;
    if (feed.status === "loaded") {
      extras[key] = feed.data;
      if (feed.refreshError) refreshErrors.push(feed.refreshError);
      continue;
    }
    extras[key] = optional.valueWhileUnavailable;
    extrasShortfalls.push(
      feed.status === "failed" ? { subject, state: "failed", error: feed.error } : { subject, state: "loading" },
    );
  }
  return {
    status: "loaded",
    data: { primary: primary.data, extras: extras as OptionalFeedValues<R>, extrasShortfalls },
    refreshError: mergeErrors(refreshErrors),
  };
}
