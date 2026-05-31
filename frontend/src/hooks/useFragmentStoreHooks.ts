/**
 * Per-component subscription hooks for `BrowserFragmentReplicaStore`.
 *
 * All hooks are thin wrappers around `useSyncExternalStore` that read one
 * specific slice of the store's state. Selecting a small slice per
 * component keeps React re-renders targeted.
 *
 * Referential stability is the store's responsibility: it only replaces
 * snapshot fields when the underlying data actually changed, so
 * `useSyncExternalStore` returns the same reference for stable subscribers
 * across renders.
 *
 * Null-tolerant: every hook accepts `store: BrowserFragmentReplicaStore | null`
 * so the caller can subscribe unconditionally even before `useDocumentSession`
 * has finished constructing the store.
 *
 * The legacy persistence (dirty/received) subscriptions are removed — the
 * receipt lifecycle no longer exists (spec 05 §"Content Flush"). In their
 * place: publication-pause and per-section editability subscriptions.
 */

import { useCallback, useSyncExternalStore } from "react";
import type {
  BrowserFragmentReplicaStore,
  CrdtConnectionState,
  SectionEditability,
} from "../services/browser-fragment-replica-store";

const EMPTY_EDITABILITY_MAP: ReadonlyMap<string, SectionEditability> = new Map();

function subscribeNoop(): () => void {
  return () => {};
}

export function useConnectionState(
  store: BrowserFragmentReplicaStore | null,
): CrdtConnectionState {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getConnectionState() : "disconnected"),
    () => "disconnected",
  );
}

export function useSynced(store: BrowserFragmentReplicaStore | null): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getSynced() : false),
    () => false,
  );
}

export function useError(
  store: BrowserFragmentReplicaStore | null,
): string | null {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getError() : null),
    () => null,
  );
}

/**
 * Subscribe to the document-level publication-pause flag. True while a
 * DocSession publish attempt is freezing editors.
 */
export function usePublishPaused(
  store: BrowserFragmentReplicaStore | null,
): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getPublishPaused() : false),
    () => false,
  );
}

/**
 * Subscribe to the full per-section editability map. Prefer
 * `useSectionEditability` when rendering many sections — this hook re-renders
 * on every map mutation regardless of which key changed.
 */
export function useSectionEditabilityMap(
  store: BrowserFragmentReplicaStore | null,
): ReadonlyMap<string, SectionEditability> {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getSectionEditability() : EMPTY_EDITABILITY_MAP),
    () => EMPTY_EDITABILITY_MAP,
  );
}

/**
 * Subscribe to the editability of a single fragment key. Components using this
 * only re-render when the specific key's state transitions — `SectionEditability`
 * is a string union so equality is cheap and stable, and `useSyncExternalStore`
 * bails out of re-rendering when the returned value is referentially equal.
 * Defaults to `"editable"` for unknown keys.
 */
export function useSectionEditability(
  store: BrowserFragmentReplicaStore | null,
  fragmentKey: string,
): SectionEditability {
  const getSnapshot = useCallback(
    () => (store ? store.getSectionEditabilityForKey(fragmentKey) : "editable"),
    [store, fragmentKey],
  );
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    getSnapshot,
    () => "editable",
  );
}
