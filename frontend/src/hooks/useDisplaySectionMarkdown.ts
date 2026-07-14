/**
 * Reactive live-fragment display selector (BUG1 display authority, F1).
 *
 * Answers "what markdown should this section paint right now?" and — unlike a
 * paint-only pure read — makes non-ySync surfaces (static preview, underlayer,
 * degraded/unfocused neighbours) re-render when the live fragment changes,
 * instead of sitting stale until focus/navigation forces a React commit.
 *
 * Subscription source is the Y.Doc's `update` event, NOT the replica store's
 * snapshot subscription: `BrowserFragmentReplicaStore.subscribe` only fires on
 * block-state / connection mutations, never on fragment content changes. Content
 * lives in the Y.Doc, so that is what we watch.
 *
 * The read underneath is `displaySectionMarkdown`: cold `section.content` seed
 * until the fragment exists in the shared doc, then the live fragment markdown.
 * Presence is a non-creating `doc.share.has(...)` — never `getXmlFragment`.
 *
 * Local in-memory only: the CRDT WebSocket already delivered the shared doc into
 * this browser's Y.Doc. No fetch, no REST, no Y.Doc write, no layout mutation.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import {
  displaySectionMarkdown,
  type DisplaySection,
} from "../services/display-section-markdown";

interface Snapshot {
  store: BrowserFragmentReplicaStore | null;
  fragmentKey: string;
  seed: string;
  tick: number;
  value: string;
}

export function useDisplaySectionMarkdown(
  section: DisplaySection,
  store: BrowserFragmentReplicaStore | null,
): string {
  const fragmentKey = section.fragment_key;
  const seed = typeof section.content === "string" ? section.content : "";

  // Bumped on every Y.Doc update so getSnapshot recomputes markdown only when
  // the shared doc actually changed — not on every unrelated React render.
  const tickRef = useRef(0);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!store) return () => {};
      const doc = store.doc;
      const listener = () => {
        tickRef.current += 1;
        onStoreChange();
      };
      doc.on("update", listener);
      return () => {
        doc.off("update", listener);
      };
    },
    [store],
  );

  // Cache the serialized markdown: it is Object.is-stable across renders (so
  // useSyncExternalStore does not thrash) and only re-serializes when the store,
  // fragment key, cold seed, or a doc-update tick actually moves.
  const cacheRef = useRef<Snapshot | null>(null);
  const getSnapshot = useCallback((): string => {
    const tick = store ? tickRef.current : -1;
    const cached = cacheRef.current;
    if (
      cached &&
      cached.store === store &&
      cached.fragmentKey === fragmentKey &&
      cached.seed === seed &&
      cached.tick === tick
    ) {
      return cached.value;
    }
    const value = displaySectionMarkdown({ content: seed, fragment_key: fragmentKey }, store);
    cacheRef.current = { store, fragmentKey, seed, tick, value };
    return value;
  }, [store, fragmentKey, seed]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
