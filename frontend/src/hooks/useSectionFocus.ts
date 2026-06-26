/**
 * useSectionFocus — focus index, pending/deferred focus, structure refocus.
 *
 * Receives useSessionMode outputs as params.
 *
 * Focus is local-only: the local focus-index / neighbor `handleCursorExit`
 * (ArrowUp/ArrowDown) and the `setViewingSections` awareness write (spec
 * §"Cross-Section Cursor Movement"). Focus / start-edit into a `"blocked"` or
 * `"gone"` section, or while a publication pause is active, is refused (read
 * from the store).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { sectionHeadingKey } from "../types/shared.js";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import { type DocumentSection, getSectionFragmentKey } from "../pages/document-page-utils";
import type { CrdtTransport } from "../services/crdt-transport";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { LocalPresence } from "../services/local-presence";

export interface UseSectionFocusParams {
  sections: DocumentSection[];
  presenceRef: React.MutableRefObject<LocalPresence | null>;
  storeRef: React.MutableRefObject<BrowserFragmentReplicaStore | null>;
  readyEditors: Set<string>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
  ensureProvider: () => Promise<CrdtTransport | null>;
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
  setViewingSection: (sectionIndex: number) => void;
}

export function useSectionFocus({
  sections,
  presenceRef,
  storeRef,
  readyEditors,
  editorRefs,
  ensureProvider,
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

  /** Refuse focus into a blocked/gone section or while a publication pause is active. */
  const canFocusSection = useCallback((section: DocumentSection | undefined): boolean => {
    const store = storeRef.current;
    if (store?.getPublishPaused()) return false;
    if (!section) return true; // empty-doc bootstrap (synthetic BFH)
    const editability = store?.getSectionEditabilityForKey(getSectionFragmentKey(section)) ?? "editable";
    return editability === "editable";
  }, [storeRef]);

  // viewingPresence: broadcast which section this client is viewing on focus change
  const setViewingSection = useCallback((sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    presenceRef.current?.setViewingSection(getSectionFragmentKey(section));
  }, [sections, presenceRef]);

  // Click-to-edit a section
  const startEditing = useCallback(async (sectionIndex: number, clickCoords?: { x: number; y: number }) => {
    const section = sections[sectionIndex];
    if (!canFocusSection(section)) return;

    const provider = await ensureProvider();
    if (!provider) return;

    setFocusedSectionIndex(sectionIndex);
    pendingFocusRef.current = { index: sectionIndex, position: "start", coords: clickCoords };
    setViewingSection(sectionIndex);
  }, [ensureProvider, sections, setViewingSection, canFocusSection]);

  // Cross-section cursor navigation
  const handleCursorExit = useCallback((sectionIndex: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    const targetSection = sections[targetIndex];
    if (!canFocusSection(targetSection)) return;

    setFocusedSectionIndex(targetIndex);
    pendingFocusRef.current = {
      index: targetIndex,
      position: direction === "up" ? "end" : "start",
    };

    if (presenceRef.current) {
      setViewingSection(targetIndex);
    }
  }, [sections, setViewingSection, presenceRef, canFocusSection]);

  // Focus editor after it is ready AND visible. Readiness + ref are keyed by
  // fragment identity, so resolve the pending index → its CURRENT fragment key.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const { index, position, coords } = pendingFocusRef.current;
    const section = sections[index];
    if (!section) return;
    const fk = getSectionFragmentKey(section);
    if (!readyEditors.has(fk)) return;

    const raf = requestAnimationFrame(() => {
      const handle = editorRefs.current.get(fk);
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
  }, [focusedSectionIndex, readyEditors, editorRefs, sections]);

  // Reconcile the React focus STATE after a structural shift. `adoptFreshSectionLayout`
  // already moved `focusedSectionIndexRef` to the focused fragment's NEW index by
  // identity, but the state at `useState` above is left stale — so the mount-window /
  // eviction effects (keyed off the state) never re-run. Syncing state to the
  // reconciled ref on every sections change fixes the index for the focused fragment
  // (or clears it when that fragment is gone). No-op when focus did not move.
  useEffect(() => {
    const reconciled = focusedSectionIndexRef.current;
    setFocusedSectionIndex((prev) => (prev === reconciled ? prev : reconciled));
  }, [sections]);

  // Restore focus after a sections refresh re-fetches sections
  useEffect(() => {
    const refocusPath = pendingStructureRefocusRef.current;
    if (!refocusPath || !presenceRef.current) return;
    pendingStructureRefocusRef.current = null;

    const exactIdx = sections.findIndex(
      (s) => sectionHeadingKey(s.heading_path) === sectionHeadingKey(refocusPath),
    );

    if (exactIdx >= 0 && canFocusSection(sections[exactIdx])) {
      setFocusedSectionIndex(exactIdx);
      pendingFocusRef.current = { index: exactIdx, position: "end" };
    } else {
      setFocusedSectionIndex(null);
    }
  }, [sections, presenceRef, canFocusSection]);

  return {
    focusedSectionIndex,
    setFocusedSectionIndex,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    mouseDownPosRef,
    startEditing,
    handleCursorExit,
    setViewingSection,
  };
}
