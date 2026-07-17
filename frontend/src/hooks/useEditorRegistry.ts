/**
 * useEditorRegistry — editor refs, ready tracking, mount window decisions.
 *
 * Owns readyEditors, editorRefs, and mountedEditorFragmentKeysRef. The
 * readyEditors eviction effect (which depends on focusedSectionIndex) lives in
 * the composition layer to avoid a circular dependency.
 *
 * Block-state awareness (Area N): `mountEligible(index)` excludes sections the
 * live replica marks blocked (spec 05 §"Section block-state events"). The
 * publish-pause quiescence barrier is owned by `useLiveSectionReplica`, the
 * single live transport owner.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  type DocumentSection,
  getSectionFragmentKey,
  shouldMountEditor,
} from "../pages/document-page-utils";

export interface UseEditorRegistryParams {
  sections: DocumentSection[];
  /** Live-replica-backed gate: true when this fragment is blocked for editing. */
  isSectionBlocked: (fragmentKey: string) => boolean;
}

export interface UseEditorRegistryReturn {
  /** Ready editors keyed by `fragment_key` (identity), not positional index. */
  readyEditors: Set<string>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Editor handles keyed by `fragment_key` (identity), not positional index. */
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  setEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  /** True when section `index` may be mounted (not blocked). */
  mountEligible: (index: number) => boolean;
}

/**
 * Evict ready editors that fall outside the mount window around the focused
 * RENDER index (a pure per-render projection — never stored focus authority).
 * readyEditors is keyed by fragment_key, so prune by whether each ready
 * fragment key's CURRENT index (resolved against the rendered rows) is still
 * inside the window; a structural shift that moves a ready fragment out of the
 * window evicts it correctly.
 */
export function useEditorWindowEviction(
  renderSections: DocumentSection[],
  focusedRenderIndex: number | null,
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<string>>>,
): void {
  useEffect(() => {
    setReadyEditors((prev) => {
      if (prev.size === 0) return prev;
      if (focusedRenderIndex === null) return new Set();
      const windowKeys = new Set<string>();
      renderSections.forEach((s, idx) => {
        if (shouldMountEditor(idx, focusedRenderIndex)) {
          windowKeys.add(getSectionFragmentKey(s));
        }
      });
      let changed = false;
      const next = new Set<string>();
      for (const fk of prev) {
        if (windowKeys.has(fk)) next.add(fk);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [focusedRenderIndex, renderSections, setReadyEditors]);
}

export function useEditorRegistry({
  sections,
  isSectionBlocked,
}: UseEditorRegistryParams): UseEditorRegistryReturn {
  const [readyEditors, setReadyEditors] = useState<Set<string>>(new Set());
  const editorRefs = useRef<Map<string, MilkdownEditorHandle>>(new Map());
  const mountedEditorFragmentKeysRef = useRef<Set<string>>(new Set());
  const sectionsRef = useRef<DocumentSection[]>([]);
  const isSectionBlockedRef = useRef(isSectionBlocked);
  isSectionBlockedRef.current = isSectionBlocked;

  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  const setEditorRef = useCallback((fragmentKey: string, handle: MilkdownEditorHandle | null) => {
    if (handle) {
      editorRefs.current.set(fragmentKey, handle);
    } else {
      editorRefs.current.delete(fragmentKey);
    }
    // editorRefs is now keyed by fragment_key, so the mounted-keys set for
    // identity-based CRDT exclusion derives directly from its keys.
    mountedEditorFragmentKeysRef.current = new Set(editorRefs.current.keys());
  }, []);

  const mountEligible = useCallback((index: number): boolean => {
    const s = sectionsRef.current[index];
    if (!s) return false;
    return !isSectionBlockedRef.current(getSectionFragmentKey(s));
  }, []);

  return {
    readyEditors,
    setReadyEditors,
    editorRefs,
    mountedEditorFragmentKeysRef,
    setEditorRef,
    mountEligible,
  };
}
