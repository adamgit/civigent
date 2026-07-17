/**
 * useSectionFocus — focus index, pending/deferred focus, structure refocus.
 *
 * Focus is local-only: the local focus-index / neighbor `handleCursorExit`
 * (ArrowUp/ArrowDown) and the viewing-presence broadcast (spec §"Cross-Section
 * Cursor Movement"). Focus into a blocked section, or while a publication
 * pause is active, is refused — both facts come from the live replica via the
 * `canFocusSection` callback (single live authority).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { sectionHeadingKey } from "../types/shared.js";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import { type DocumentSection, getSectionFragmentKey } from "../pages/document-page-utils";

export interface UseSectionFocusParams {
  sections: DocumentSection[];
  /** Live-replica-backed gate: false for blocked sections / during a publish pause. */
  canFocusSection: (section: DocumentSection | undefined) => boolean;
  /** Broadcast which fragment this client is viewing (awareness presence). */
  publishViewingSection: (fragmentKey: string) => void;
  readyEditors: Set<string>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
}

export interface PendingEditorFocus {
  /** Fragment identity of the editor that should take the caret when ready. */
  fragmentKey: string;
  position: "start" | "end";
  coords?: { x: number; y: number };
}

export interface UseSectionFocusReturn {
  /** COLD-path stored focus. The live path stores focus as `SectionId` on the
   *  page and never writes it back here. */
  focusedSectionIndex: number | null;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  pendingFocusRef: React.MutableRefObject<PendingEditorFocus | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setViewingSection: (sectionIndex: number) => void;
}

export function useSectionFocus({
  sections,
  canFocusSection,
  publishViewingSection,
  readyEditors,
  editorRefs,
}: UseSectionFocusParams): UseSectionFocusReturn {
  const [focusedSectionIndex, setFocusedSectionIndex] = useState<number | null>(null);
  const pendingFocusRef = useRef<PendingEditorFocus | null>(null);
  const pendingStructureRefocusRef = useRef<string[] | null>(null);
  const focusedSectionIndexRef = useRef<number | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  // Sync ref + clear stale pendingFocus when editing stops
  useEffect(() => {
    if (focusedSectionIndex === null) pendingFocusRef.current = null;
    focusedSectionIndexRef.current = focusedSectionIndex;
  }, [focusedSectionIndex]);

  // viewingPresence: broadcast which section this client is viewing on focus change
  const setViewingSection = useCallback((sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    publishViewingSection(getSectionFragmentKey(section));
  }, [sections, publishViewingSection]);

  // Cross-section cursor navigation
  const handleCursorExit = useCallback((sectionIndex: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    const targetSection = sections[targetIndex];
    if (!canFocusSection(targetSection)) return;

    setFocusedSectionIndex(targetIndex);
    pendingFocusRef.current = {
      fragmentKey: getSectionFragmentKey(targetSection),
      position: direction === "up" ? "end" : "start",
    };
    setViewingSection(targetIndex);
  }, [sections, setViewingSection, canFocusSection]);

  // Focus editor after it is ready AND visible. The pending target, readiness,
  // and refs are ALL keyed by fragment identity — a structural index shift
  // between click and editor-ready cannot land the caret in the wrong section.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const { fragmentKey, position, coords } = pendingFocusRef.current;
    if (!readyEditors.has(fragmentKey)) return;

    const raf = requestAnimationFrame(() => {
      const handle = editorRefs.current.get(fragmentKey);
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

  // Reconcile the React focus STATE after a structural shift: the mount-window /
  // eviction effects are keyed off the state, so sync it to the reconciled ref on
  // every sections change. No-op when focus did not move.
  useEffect(() => {
    const reconciled = focusedSectionIndexRef.current;
    setFocusedSectionIndex((prev) => (prev === reconciled ? prev : reconciled));
  }, [sections]);

  // Restore focus after a sections refresh re-fetches sections
  useEffect(() => {
    const refocusPath = pendingStructureRefocusRef.current;
    if (!refocusPath) return;
    pendingStructureRefocusRef.current = null;

    const exactIdx = sections.findIndex(
      (s) => sectionHeadingKey(s.heading_path) === sectionHeadingKey(refocusPath),
    );

    if (exactIdx >= 0 && canFocusSection(sections[exactIdx])) {
      setFocusedSectionIndex(exactIdx);
      pendingFocusRef.current = {
        fragmentKey: getSectionFragmentKey(sections[exactIdx]),
        position: "end",
      };
    } else {
      setFocusedSectionIndex(null);
    }
  }, [sections, canFocusSection]);

  return {
    focusedSectionIndex,
    setFocusedSectionIndex,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    mouseDownPosRef,
    handleCursorExit,
    setViewingSection,
  };
}
