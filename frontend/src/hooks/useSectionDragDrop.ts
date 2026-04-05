/**
 * useSectionDragDrop — Delegated drag/drop for static (non-editor) sections.
 *
 * Attaches event listeners to the section list container via delegation.
 * Handles dragover (canDrop check), drop (build transfer + execute),
 * and cleanup (dragleave/dragend).
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

import { useEffect, useState, useCallback, type RefObject } from "react";
import { dragSourceInfo } from "../components/MilkdownEditor";
import { proseMirrorNodeToMarkdown } from "@ks/milkdown-serializer";
import { domPosToMarkdownOffset } from "../services/drop-position";
import type {
  SectionTransferService,
  SectionTransfer,
  TransferResult,
} from "../services/section-transfer";

export interface UseSectionDragDropOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  transferService: SectionTransferService | null;
  /** Map section index → fragment key for looking up drop targets. */
  getFragmentKey: (sectionIndex: number) => string | null;
  /** Map section index → heading path. */
  getHeadingPath: (sectionIndex: number) => string[] | null;
  /** Whether a section index has a mounted editor (skip — ProseMirror handles it). */
  hasEditor: (sectionIndex: number) => boolean;
  /** Map section index → section markdown content (for insertion offset). */
  getSectionContent?: (sectionIndex: number) => string | null;
  onTransferComplete?: (result: TransferResult) => void;
}

export interface UseSectionDragDropResult {
  dragOverSectionIndex: number | null;
}

export function useSectionDragDrop(opts: UseSectionDragDropOptions): UseSectionDragDropResult {
  const {
    containerRef,
    transferService,
    getFragmentKey,
    getHeadingPath,
    hasEditor,
    getSectionContent,
    onTransferComplete,
  } = opts;

  const [dragOverSectionIndex, setDragOverSectionIndex] = useState<number | null>(null);
  // Track static drag source (section index) captured at dragstart
  const staticDragSourceRef = { current: null as number | null };
  // Drop-position indicator element
  const dropIndicatorRef = { current: null as HTMLDivElement | null };

  const removeDropIndicator = useCallback(() => {
    if (dropIndicatorRef.current) {
      dropIndicatorRef.current.remove();
      dropIndicatorRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback((e: DragEvent) => {
    const sectionEl = (e.target as HTMLElement)?.closest?.("[data-section-index]");
    if (!sectionEl) return;
    const idx = Number(sectionEl.getAttribute("data-section-index"));
    if (!isNaN(idx) && !hasEditor(idx)) {
      staticDragSourceRef.current = idx;
    }
  }, [hasEditor]);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!transferService) return;

    // Let native text-selection drags pass through unmolested
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !dragSourceInfo) return;

    const sectionEl = (e.target as HTMLElement)?.closest?.("[data-section-index]");
    if (!sectionEl) return;

    const idx = Number(sectionEl.getAttribute("data-section-index"));
    if (isNaN(idx)) return;

    // Skip sections with mounted editors — ProseMirror handles them
    if (hasEditor(idx)) return;

    const fk = getFragmentKey(idx);
    if (!fk) return;

    const verdict = transferService.canDrop(fk);
    if (verdict.allowed) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = dragSourceInfo ? "move" : "copy";
      setDragOverSectionIndex(idx);

      // Position drop indicator
      if (sectionEl instanceof HTMLElement) {
        const range = (document as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null;
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
    }
  }, [transferService, getFragmentKey, hasEditor]);

  const handleDrop = useCallback(async (e: DragEvent) => {
    if (!transferService) return;

    // Let native text-selection drags pass through unmolested
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !dragSourceInfo) return;

    const sectionEl = (e.target as HTMLElement)?.closest?.("[data-section-index]");
    if (!sectionEl) return;

    const idx = Number(sectionEl.getAttribute("data-section-index"));
    if (isNaN(idx)) return;
    if (hasEditor(idx)) return;

    e.preventDefault();
    setDragOverSectionIndex(null);
    removeDropIndicator();

    const fk = getFragmentKey(idx);
    const hp = getHeadingPath(idx);
    if (!fk || !hp) return;

    const plainText = e.dataTransfer?.getData("text/plain") ?? "";

    const source = dragSourceInfo;

    // Source is null when dragging from a static (non-editor) section —
    // no ProseMirror dragstart handler exists to set dragSourceInfo.
    // For static sources, resolve fragmentKey from the captured section index.
    let deleteSourceCallback: (() => void) | undefined;
    let sourceFragmentKey = "";
    let sourceSliceRange: { from: number; to: number } | null = null;
    const deleteFromSource = !!source;
    let markdown = "";

    if (!source && staticDragSourceRef.current !== null) {
      // Static drag — resolve source fragment key from captured section index
      sourceFragmentKey = getFragmentKey(staticDragSourceRef.current) ?? "";
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

    // Resolve source heading path from fragment key by scanning sections
    let sourceHeadingPath: string[] = [];
    if (sourceFragmentKey) {
      for (let si = 0; ; si++) {
        const sfk = getFragmentKey(si);
        if (sfk === null) break;
        if (sfk === sourceFragmentKey) {
          sourceHeadingPath = getHeadingPath(si) ?? [];
          break;
        }
      }
    }

    // Compute insertion offset from drop position for static targets
    let insertionOffset: number | undefined;
    const sectionContent = getSectionContent?.(idx);
    if (sectionContent && e.clientX && e.clientY) {
      const range = (document as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null;
      if (range && sectionEl instanceof HTMLElement) {
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
  }, [transferService, getFragmentKey, getHeadingPath, hasEditor, getSectionContent, removeDropIndicator, onTransferComplete]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    // Only clear if leaving the section entirely (not entering a child)
    const related = e.relatedTarget as HTMLElement | null;
    const sectionEl = (e.target as HTMLElement)?.closest?.("[data-section-index]");
    if (sectionEl && related && sectionEl.contains(related)) return;
    setDragOverSectionIndex(null);
    removeDropIndicator();
  }, [removeDropIndicator]);

  const handleDragEnd = useCallback(() => {
    setDragOverSectionIndex(null);
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

  return { dragOverSectionIndex };
}
