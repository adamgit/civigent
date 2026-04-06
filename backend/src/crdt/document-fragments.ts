import { FragmentStore } from "./fragment-store.js";

/**
 * DocumentFragments is the preferred runtime name for per-document live
 * fragment state. It intentionally reuses FragmentStore implementation during
 * migration to avoid splitting behavior across two competing owners.
 */
export { FragmentStore as DocumentFragments };

export type {
  FromDiskResult as DocumentFragmentsFromDiskResult,
  FlushResult,
  NormalizeResult,
  OrphanedBody,
} from "./fragment-store.js";

