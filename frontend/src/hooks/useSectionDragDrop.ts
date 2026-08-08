/**
 * useSectionDragDrop — Delegated drag/drop for static (non-editor) sections.
 *
 * Attaches event listeners to the section list container via delegation.
 * Handles dragover (canDrop check), drop (build transfer + execute),
 * and cleanup (dragleave/dragend).
 *
 * Identity is FRAGMENT-KEY-NATIVE end to end: targets/sources resolve from the
 * `data-fragment-key` on the nearest `data-document-section` wrapper, drag
 * state (drag-over highlight, static drag source) is stored as fragment keys,
 * and the option readers are keyed by fragment key. Positional indices are
 * never read from the DOM or stored as drag state.
 *
 * Supports two drag-source scenarios:
 *   1. Editor → static: dragSourceInfo is set by MilkdownEditor's ProseMirror plugin.
 *      Content is moved (deleted from source editor after write to target).
 *   2. Static → static: no ProseMirror involved, so dragSourceInfo is null.
 *      Content is copied using the browser's native dataTransfer (no source deletion).
 *
 * Editor sections are handled by the ProseMirror plugin in MilkdownEditor
 * (Phase 2). This hook only handles drops onto sections that don't have
 * a mounted editor (static rendered HTML).
 */

import { useEffect, useState, useCallback, useRef, type RefObject } from "react";
import { dragSourceInfo } from "../components/crossSectionDropPlugin";
import { proseMirrorNodeToMarkdown } from "@ks/milkdown-serializer";
import { domPosToMarkdownOffset } from "../services/drop-position";
import {
  applyDragOverVerdict,
  type SectionTransferService,
  type SectionTransfer,
  type TransferResult,
} from "../services/section-transfer";

/** Real document section wrappers only (see DocumentSectionRenderer). */
const SECTION_WRAPPER_SELECTOR = "[data-document-section][data-fragment-key]";

function wrapperFragmentKey(target: EventTarget | null): { el: HTMLElement; fragmentKey: string } | null {
  const el = (target as HTMLElement)?.closest?.(SECTION_WRAPPER_SELECTOR);
  if (!(el instanceof HTMLElement)) return null;
  const fragmentKey = el.dataset.fragmentKey;
  if (!fragmentKey) return null;
  return { el, fragmentKey };
}

export interface UseSectionDragDropOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  transferService: SectionTransferService | null;
  /** Fragment key → heading path (null when the key is not a current row). */
  getHeadingPath: (fragmentKey: string) => string[] | null;
  /** Whether a fragment has a mounted editor (skip — ProseMirror handles it). */
  hasEditor: (fragmentKey: string) => boolean;
  /** Fragment key → the section's display markdown (for insertion offset). */
  getSectionContent?: (fragmentKey: string) => string | null;
  onTransferComplete?: (result: TransferResult) => void;
}

export interface UseSectionDragDropResult {
  /** Fragment key of the section currently dragged over (highlight target). */
  dragOverFragmentKey: string | null;
}

export function useSectionDragDrop(opts: UseSectionDragDropOptions): UseSectionDragDropResult {
  const {
    containerRef,
    transferService,
    getHeadingPath,
    hasEditor,
    getSectionContent,
    onTransferComplete,
  } = opts;

  const [dragOverFragmentKey, setDragOverFragmentKey] = useState<string | null>(null);
  // Static drag source (fragment key) captured at dragstart. Real refs: the
  // drag-over state update re-renders the page mid-drag, and drag state must
  // survive that re-render.
  const staticDragSourceRef = useRef<string | null>(null);
  // Drop-position indicator element
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);

  const removeDropIndicator = useCallback(() => {
    if (dropIndicatorRef.current) {
      dropIndicatorRef.current.remove();
      dropIndicatorRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback((e: DragEvent) => {
    const hit = wrapperFragmentKey(e.target);
    if (!hit) return;
    if (!hasEditor(hit.fragmentKey)) {
      staticDragSourceRef.current = hit.fragmentKey;
    }
  }, [hasEditor]);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!transferService) return;

    // Let native text-selection drags pass through unmolested
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !dragSourceInfo) return;

    const hit = wrapperFragmentKey(e.target);
    if (!hit) return;
    const { el: sectionEl, fragmentKey: fk } = hit;

    // Skip sections with mounted editors — ProseMirror handles them
    if (hasEditor(fk)) return;

    const verdict = transferService.canDrop(fk);
    if (applyDragOverVerdict(e, verdict, !!dragSourceInfo)) {
      setDragOverFragmentKey(fk);

      // Position drop indicator
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
      if (range) {
        const rect = range.getBoundingClientRect();
        const containerRect = sectionEl.getBoundingClientRect();
        if (!dropIndicatorRef.current) {
          const div = document.createElement("div");
          div.style.cssText = "position:absolute;left:0;right:0;height:2px;background:#3b82f6;pointer-events:none;z-index:50;transition:top 0.05s ease-out";
          sectionEl.style.position = "relative";
          sectionEl.appendChild(div);
          dropIndicatorRef.current = div;
        }
        dropIndicatorRef.current.style.top = `${rect.top - containerRect.top}px`;
        if (dropIndicatorRef.current.parentElement !== sectionEl) {
          sectionEl.style.position = "relative";
          sectionEl.appendChild(dropIndicatorRef.current);
        }
      }
    }
  }, [transferService, hasEditor]);

  const handleDrop = useCallback(async (e: DragEvent) => {
    if (!transferService) return;

    // Let native text-selection drags pass through unmolested
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !dragSourceInfo) return;

    const hit = wrapperFragmentKey(e.target);
    if (!hit) return;
    const { el: sectionEl, fragmentKey: fk } = hit;
    if (hasEditor(fk)) return;

    e.preventDefault();
    setDragOverFragmentKey(null);
    removeDropIndicator();

    const hp = getHeadingPath(fk);
    if (!hp) return;

    const plainText = e.dataTransfer?.getData("text/plain") ?? "";

    const source = dragSourceInfo;

    // Source is null when dragging from a static (non-editor) section —
    // no ProseMirror dragstart handler exists to set dragSourceInfo.
    // For static sources, the fragment key was captured at dragstart.
    let deleteSourceCallback: (() => void) | undefined;
    let sourceFragmentKey = "";
    let sourceSliceRange: { from: number; to: number } | null = null;
    const deleteFromSource = !!source;
    let markdown = "";

    if (!source && staticDragSourceRef.current !== null) {
      sourceFragmentKey = staticDragSourceRef.current;
    }
    staticDragSourceRef.current = null;

    if (source) {
      sourceFragmentKey = source.fragmentKey;
      sourceSliceRange = { from: source.from, to: source.to };
      const sourceView = source.view;
      const sourceFrom = source.from;
      const sourceTo = source.to;

      // Extract markdown from the ProseMirror document to preserve structure
      // (headings, lists, etc.) — same pattern as useCrossSectionCopy.
      const slice = sourceView.state.doc.slice(sourceFrom, sourceTo);
      const docNode = sourceView.state.doc.type.create(null, slice.content);
      markdown = proseMirrorNodeToMarkdown(docNode);

      deleteSourceCallback = () => {
        const tr = sourceView.state.tr.delete(sourceFrom, sourceTo);
        sourceView.dispatch(tr);
      };
    } else {
      markdown = plainText;
    }

    // Source heading path resolves by fragment-key lookup.
    const sourceHeadingPath: string[] = sourceFragmentKey
      ? (getHeadingPath(sourceFragmentKey) ?? [])
      : [];

    // Compute insertion offset from drop position for static targets
    let insertionOffset: number | undefined;
    const sectionContent = getSectionContent?.(fk);
    if (sectionContent && e.clientX && e.clientY) {
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
      if (range) {
        insertionOffset = domPosToMarkdownOffset(sectionEl, range, sectionContent);
      }
    }

    const transfer: SectionTransfer = {
      sourceFragmentKey,
      sourceHeadingPath,
      targetFragmentKey: fk,
      targetHeadingPath: hp,
      content: { markdown, plainText },
      sourceSliceRange,
      deleteFromSource,
      deleteSourceCallback,
      insertionOffset,
    };

    const result = await transferService.execute(transfer);
    onTransferComplete?.(result);
  }, [transferService, getHeadingPath, hasEditor, getSectionContent, removeDropIndicator, onTransferComplete]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    // Only clear if leaving the section entirely (not entering a child)
    const related = e.relatedTarget as HTMLElement | null;
    const hit = wrapperFragmentKey(e.target);
    if (hit && related && hit.el.contains(related)) return;
    setDragOverFragmentKey(null);
    removeDropIndicator();
  }, [removeDropIndicator]);

  const handleDragEnd = useCallback(() => {
    setDragOverFragmentKey(null);
    removeDropIndicator();
  }, [removeDropIndicator]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dragStartFn = handleDragStart as unknown as EventListener;
    const dragOverFn = handleDragOver as unknown as EventListener;
    const dropFn = handleDrop as unknown as EventListener;
    const dragLeaveFn = handleDragLeave as unknown as EventListener;
    const dragEndFn = handleDragEnd as unknown as EventListener;

    container.addEventListener("dragstart", dragStartFn);
    container.addEventListener("dragover", dragOverFn);
    container.addEventListener("drop", dropFn);
    container.addEventListener("dragleave", dragLeaveFn);
    container.addEventListener("dragend", dragEndFn);

    return () => {
      container.removeEventListener("dragstart", dragStartFn);
      container.removeEventListener("dragover", dragOverFn);
      container.removeEventListener("drop", dropFn);
      container.removeEventListener("dragleave", dragLeaveFn);
      container.removeEventListener("dragend", dragEndFn);
    };
  }, [containerRef, handleDragStart, handleDragOver, handleDrop, handleDragLeave, handleDragEnd]);

  return { dragOverFragmentKey };
}
