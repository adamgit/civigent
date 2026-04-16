/**
 * useSectionFocus — focus index, pending/deferred focus, structure refocus.
 *
 * Extracted from useDocumentCrdt. Receives useSessionMode outputs as params.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  sectionHeadingKey,
  type DocumentSessionControllerState,
} from "../types/shared.js";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import { type DocumentSection, getSectionFragmentKey } from "../pages/document-page-utils";
import type { CrdtProvider } from "../services/crdt-provider";

export interface UseSectionFocusParams {
  sections: DocumentSection[];
  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  readyEditors: Set<number>;
  editorRefs: React.MutableRefObject<Map<number, MilkdownEditorHandle>>;
  ensureProvider: () => Promise<CrdtProvider | null>;
  setControllerState: React.Dispatch<React.SetStateAction<DocumentSessionControllerState>>;
}

export interface UseSectionFocusReturn {
  focusedSectionIndex: number | null;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  pendingFocusRef: React.MutableRefObject<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  startEditing: (sectionIndex: number, clickCoords?: { x: number; y: number }) => Promise<void>;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setViewingSections: (provider: CrdtProvider, sectionIndex: number) => void;
}

export function useSectionFocus({
  sections,
  crdtProviderRef,
  readyEditors,
  editorRefs,
  ensureProvider,
  setControllerState,
}: UseSectionFocusParams): UseSectionFocusReturn {
  const [focusedSectionIndex, setFocusedSectionIndex] = useState<number | null>(null);
  const pendingFocusRef = useRef<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>(null);
  const pendingStructureRefocusRef = useRef<string[] | null>(null);
  const focusedSectionIndexRef = useRef<number | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  // Sync ref + clear stale pendingFocus when editing stops
  useEffect(() => {
    if (focusedSectionIndex === null) pendingFocusRef.current = null;
    focusedSectionIndexRef.current = focusedSectionIndex;
  }, [focusedSectionIndex]);

  // viewingPresence: set Awareness viewingSections on focus change
  const setViewingSections = useCallback((provider: CrdtProvider, sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    const fk = getSectionFragmentKey(section);
    const currentUser = provider.awareness.getLocalState()?.user;
    provider.awareness.setLocalStateField("user", {
      ...currentUser,
      viewingSections: [fk],
    });
  }, [sections]);

  // Click-to-edit a section
  const startEditing = useCallback(async (sectionIndex: number, clickCoords?: { x: number; y: number }) => {
    const provider = await ensureProvider();
    if (!provider) return;

    setFocusedSectionIndex(sectionIndex);
    pendingFocusRef.current = { index: sectionIndex, position: "start", coords: clickCoords };

    const section = sections[sectionIndex];
    if (section) {
      provider.focusSection(section.heading_path);
      setControllerState((prev) => ({
        ...prev,
        editorFocusTarget: section.heading_path.length > 0
          ? { kind: "heading_path", heading_path: section.heading_path }
          : { kind: "before_first_heading" },
      }));
    } else if (sectionIndex === 0 && sections.length === 0) {
      // Empty-document bootstrap: the synthetic BFH row materializes into
      // displaySections once editor mode + CRDT sync land. Pre-set BFH focus
      // so the server routes presence correctly and pendingFocus fires when
      // the editor mounts for the synthetic row at index 0.
      provider.focusSection([]);
      setControllerState((prev) => ({
        ...prev,
        editorFocusTarget: { kind: "before_first_heading" },
      }));
    }
    setViewingSections(provider, sectionIndex);
  }, [ensureProvider, sections, setViewingSections, setControllerState]);

  // Cross-section cursor navigation
  const handleCursorExit = useCallback((sectionIndex: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    setFocusedSectionIndex(targetIndex);
    pendingFocusRef.current = {
      index: targetIndex,
      position: direction === "up" ? "end" : "start",
    };

    const provider = crdtProviderRef.current;
    const targetSection = sections[targetIndex];
    if (provider && targetSection) {
      provider.focusSection(targetSection.heading_path);
      setControllerState((prev) => ({
        ...prev,
        editorFocusTarget: targetSection.heading_path.length > 0
          ? { kind: "heading_path", heading_path: targetSection.heading_path }
          : { kind: "before_first_heading" },
      }));
    }
    if (provider) {
      setViewingSections(provider, targetIndex);
    }
  }, [sections, setViewingSections, crdtProviderRef, setControllerState]);

  // Focus editor after it is ready AND visible
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const { index, position, coords } = pendingFocusRef.current;
    if (!readyEditors.has(index)) return;

    const raf = requestAnimationFrame(() => {
      const handle = editorRefs.current.get(index);
      if (handle) {
        if (coords) {
          handle.focusAtCoords(coords.x, coords.y);
        } else {
          handle.focus(position);
        }
      }
      pendingFocusRef.current = null;
    });

    return () => cancelAnimationFrame(raf);
  }, [focusedSectionIndex, readyEditors, editorRefs]);

  // Restore focus after doc_structure:changed re-fetches sections
  useEffect(() => {
    const refocusPath = pendingStructureRefocusRef.current;
    if (!refocusPath || !crdtProviderRef.current) return;
    pendingStructureRefocusRef.current = null;

    const exactIdx = sections.findIndex(
      (s) => sectionHeadingKey(s.heading_path) === sectionHeadingKey(refocusPath),
    );

    if (exactIdx >= 0) {
      setFocusedSectionIndex(exactIdx);
      pendingFocusRef.current = { index: exactIdx, position: "end" };
      crdtProviderRef.current.focusSection(sections[exactIdx].heading_path);
    } else {
      setFocusedSectionIndex(null);
    }
  }, [sections, crdtProviderRef]);

  return {
    focusedSectionIndex,
    setFocusedSectionIndex,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    mouseDownPosRef,
    startEditing,
    handleCursorExit,
    setViewingSections,
  };
}
