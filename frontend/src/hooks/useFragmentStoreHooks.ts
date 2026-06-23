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
 * Exposes publication-pause and per-section editability subscriptions.
 */

import { useCallback, useSyncExternalStore } from "react";
import type {
  BrowserFragmentReplicaStore,
  CrdtConnectionState,
  PendingSection,
  SectionEditability,
} from "../services/browser-fragment-replica-store";

const EMPTY_EDITABILITY_MAP: ReadonlyMap<string, SectionEditability> = new Map();
const EMPTY_PENDING_MAP: ReadonlyMap<string, PendingSection> = new Map();

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
 * Guarantee A (doc-level): subscribe to whether every local edit has been
 * acknowledged received by the server. False while edits are in flight.
 */
export function useReceiptAllReceived(
  store: BrowserFragmentReplicaStore | null,
): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getReceiptAllReceived() : true),
    () => true,
  );
}

/** Guarantee B: subscribe to the full pending-sections map. */
export function usePendingSections(
  store: BrowserFragmentReplicaStore | null,
): ReadonlyMap<string, PendingSection> {
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    () => (store ? store.getPendingSections() : EMPTY_PENDING_MAP),
    () => EMPTY_PENDING_MAP,
  );
}

/**
 * Guarantee B: subscribe to a single fragment's pending entry (or null). Used by
 * the per-section gutter affordance to show "edited by X — not yet saved".
 */
export function usePendingSectionForKey(
  store: BrowserFragmentReplicaStore | null,
  fragmentKey: string,
): PendingSection | null {
  const getSnapshot = useCallback(
    () => (store ? store.getPendingSectionForKey(fragmentKey) : null),
    [store, fragmentKey],
  );
  return useSyncExternalStore(
    store ? store.subscribe : subscribeNoop,
    getSnapshot,
    () => null,
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
