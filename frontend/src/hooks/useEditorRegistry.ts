/**
 * useEditorRegistry — editor refs, ready tracking, mount window decisions.
 *
 * Extracted from useDocumentCrdt. Owns readyEditors, editorRefs, and
 * mountedEditorFragmentKeysRef. The readyEditors eviction effect (which
 * depends on focusedSectionIndex) lives in the composition layer to avoid
 * a circular dependency.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  type DocumentSection,
  getSectionFragmentKey,
} from "../pages/document-page-utils";

export interface UseEditorRegistryParams {
  sections: DocumentSection[];
}

export interface UseEditorRegistryReturn {
  readyEditors: Set<number>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<number>>>;
  editorRefs: React.MutableRefObject<Map<number, MilkdownEditorHandle>>;
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  setEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
}

export function useEditorRegistry({
  sections,
}: UseEditorRegistryParams): UseEditorRegistryReturn {
  const [readyEditors, setReadyEditors] = useState<Set<number>>(new Set());
  const editorRefs = useRef<Map<number, MilkdownEditorHandle>>(new Map());
  const mountedEditorFragmentKeysRef = useRef<Set<string>>(new Set());
  const sectionsRef = useRef<DocumentSection[]>([]);

  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

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

  return {
    readyEditors,
    setReadyEditors,
    editorRefs,
    mountedEditorFragmentKeysRef,
    setEditorRef,
  };
}
