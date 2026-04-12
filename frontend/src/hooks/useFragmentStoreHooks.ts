/**
 * Per-component subscription hooks for `BrowserFragmentReplicaStore`.
 *
 * All hooks are thin wrappers around `useSyncExternalStore` that read one
 * specific slice of the store's state. Selecting a small slice per
 * component keeps React re-renders targeted — a change to the connection
 * state only triggers re-renders in components that subscribed via
 * `useConnectionState`, not every component that touches the store.
 *
 * Referential stability is the store's responsibility: it only replaces
 * snapshot fields when the underlying data actually changed, so
 * `useSyncExternalStore` will return the same reference for stable
 * subscribers across renders.
 *
 * Null-tolerant: every hook accepts `store: BrowserFragmentReplicaStore | null`
 * so the caller can subscribe unconditionally even before
 * `useDocumentSession` has finished constructing the store.
 */

import { useCallback, useSyncExternalStore } from "react";
import type {
  BrowserFragmentReplicaStore,
  CrdtConnectionState,
  SectionPersistenceState,
} from "../services/browser-fragment-replica-store";

const EMPTY_SECTION_MAP: ReadonlyMap<string, SectionPersistenceState> = new Map();

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
 * Subscribe to the full section-persistence map. Prefer
 * `useSectionPersistenceForKey` when rendering many sections — this hook
 * re-renders on every map mutation, regardless of which key changed.
 */
export function useSectionPersistence(
  store: BrowserFragmentReplicaStore | null,
): ReadonlyMap<string, SectionPersistenceState> {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getSectionPersistence() : EMPTY_SECTION_MAP),
    () => EMPTY_SECTION_MAP,
  );
}

/**
 * Subscribe to the persistence state of a single fragment key. Components
 * using this only re-render when the specific key's state transitions
 * (other map mutations that leave this key untouched are filtered).
 *
 * Filtering happens inside the snapshot getter — `useSyncExternalStore`
 * bails out of re-rendering when the returned value is referentially
 * equal. Since `SectionPersistenceState` is a string union, equality is
 * cheap and stable.
 */
export function useSectionPersistenceForKey(
  store: BrowserFragmentReplicaStore | null,
  fragmentKey: string,
): SectionPersistenceState {
  const getSnapshot = useCallback(
    () => (store ? store.getSectionPersistenceForKey(fragmentKey) : "clean"),
    [store, fragmentKey],
  );
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    getSnapshot,
    () => "clean",
  );
}
