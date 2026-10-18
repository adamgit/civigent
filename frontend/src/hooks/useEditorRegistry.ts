import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import { shouldMountEditorForFragment } from "../pages/document-page-utils";
import { SectionId, type RenderSectionRef } from "../types/live-sections";
import { useCrossSectionSpanKeys } from "../components/crossSectionSelection";

export interface UseEditorRegistryReturn {
  readyEditors: Set<string>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<string>>>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
  setEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
}

export function useEditorWindowEviction(
  renderSections: readonly RenderSectionRef[],
  focusedFragmentKey: string | null,
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<string>>>,
): void {
  const spanKeys = useCrossSectionSpanKeys();
  useEffect(() => {
    setReadyEditors((prev) => {
      if (prev.size === 0) return prev;
      if (focusedFragmentKey === null) return new Set();
      const orderedKeys = renderSections.map((s) => SectionId.text(s.id));
      const keep = new Set(spanKeys);
      let changed = false;
      const next = new Set<string>();
      for (const fk of prev) {
        if (keep.has(fk) || shouldMountEditorForFragment(fk, focusedFragmentKey, orderedKeys, prev.has(focusedFragmentKey))) next.add(fk);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [focusedFragmentKey, renderSections, setReadyEditors, spanKeys]);
}

export function useEditorRegistry(): UseEditorRegistryReturn {
  const [readyEditors, setReadyEditors] = useState<Set<string>>(new Set());
  const editorRefs = useRef<Map<string, MilkdownEditorHandle>>(new Map());

  const setEditorRef = useCallback((fragmentKey: string, handle: MilkdownEditorHandle | null) => {
    if (handle) {
      editorRefs.current.set(fragmentKey, handle);
    } else {
      editorRefs.current.delete(fragmentKey);
    }
  }, []);

  return {
    readyEditors,
    setReadyEditors,
    editorRefs,
    setEditorRef,
  };
}
