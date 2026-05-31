/**
 * useEditorRegistry — editor refs, ready tracking, mount window decisions.
 *
 * Owns readyEditors, editorRefs, and mountedEditorFragmentKeysRef. The
 * readyEditors eviction effect (which depends on focusedSectionIndex) lives in
 * the composition layer to avoid a circular dependency.
 *
 * Block-state / publish-pause awareness (Area N):
 *   - `mountEligible(index)` excludes sections the server marked `"blocked"` or
 *     `"gone"` (spec 05 §"Section block-state events").
 *   - When a publication pause is active, the provider's quiescence barrier
 *     (registered here) freezes editors and resolves once local Yjs transaction
 *     production has settled, before the provider sends `doc_publish_ready`
 *     (spec 05 §"DocSession publish pause messages"). The provider is the single
 *     owner of the barrier; this registry only supplies the freeze/settle hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  type DocumentSection,
  getSectionFragmentKey,
} from "../pages/document-page-utils";
import type {
  BrowserFragmentReplicaStore,
  SectionEditability,
} from "../services/browser-fragment-replica-store";
import type { CrdtProvider, PublishPauseBarrier } from "../services/crdt-provider";

export interface UseEditorRegistryParams {
  sections: DocumentSection[];
  store: BrowserFragmentReplicaStore | null;
  crdtProvider: CrdtProvider | null;
}

export interface UseEditorRegistryReturn {
  readyEditors: Set<number>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<number>>>;
  editorRefs: React.MutableRefObject<Map<number, MilkdownEditorHandle>>;
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  setEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
  /** True when section `index` may be mounted (not blocked, not gone). */
  mountEligible: (index: number) => boolean;
}

/** Two animation frames — enough for React to commit the readOnly flip onto
 *  every mounted editor before we declare the client quiescent. */
function settleQuiescence(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function useEditorRegistry({
  sections,
  store,
  crdtProvider,
}: UseEditorRegistryParams): UseEditorRegistryReturn {
  const [readyEditors, setReadyEditors] = useState<Set<number>>(new Set());
  const editorRefs = useRef<Map<number, MilkdownEditorHandle>>(new Map());
  const mountedEditorFragmentKeysRef = useRef<Set<string>>(new Set());
  const sectionsRef = useRef<DocumentSection[]>([]);
  const storeRef = useRef<BrowserFragmentReplicaStore | null>(store);

  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  const setEditorRef = useCallback((index: number, handle: MilkdownEditorHandle | null) => {
    if (handle) {
      editorRefs.current.set(index, handle);
    } else {
      editorRefs.current.delete(index);
    }
    // Keep mountedEditorFragmentKeysRef in sync for identity-based CRDT exclusion.
    const mounted = new Set<string>();
    for (const i of editorRefs.current.keys()) {
      const s = sectionsRef.current[i];
      if (s) {
        mounted.add(getSectionFragmentKey(s));
      }
    }
    mountedEditorFragmentKeysRef.current = mounted;
  }, []);

  const mountEligible = useCallback((index: number): boolean => {
    const s = sectionsRef.current[index];
    if (!s) return false;
    const editability: SectionEditability =
      storeRef.current?.getSectionEditabilityForKey(getSectionFragmentKey(s)) ?? "editable";
    return editability === "editable";
  }, []);

  // Register the publish-pause quiescence barrier with the provider. The
  // store's `publishPaused` flag (set by the transport on pause_start) already
  // drives editors read-only; freeze() only needs to wait for that flip to
  // commit before the provider sends `doc_publish_ready`.
  useEffect(() => {
    if (!crdtProvider) return;
    const barrier: PublishPauseBarrier = {
      freeze: () => settleQuiescence(),
      unfreeze: () => { /* store flag flip re-enables editors */ },
    };
    crdtProvider.setPublishPauseBarrier(barrier);
    return () => {
      crdtProvider.setPublishPauseBarrier(null);
    };
  }, [crdtProvider]);

  return {
    readyEditors,
    setReadyEditors,
    editorRefs,
    mountedEditorFragmentKeysRef,
    setEditorRef,
    mountEligible,
  };
}
