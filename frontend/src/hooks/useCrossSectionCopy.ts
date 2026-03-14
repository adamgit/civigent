/**
 * useCrossSectionCopy — intercepts Ctrl-C when selection spans multiple
 * section editors and writes clean markdown to the clipboard.
 *
 * Single-section selections are left to Milkdown's native copy handler.
 */

import { useEffect } from "react";
import { proseMirrorNodeToMarkdown } from "@ks/milkdown-serializer";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";

export interface CrossSectionCopyOptions {
  /** Ref to the container div that wraps all section elements. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Current sections data (heading_path, content, depth, etc.). */
  sections: Array<{
    heading_path: string[];
    content: string;
    depth: number;
    heading: string;
  }>;
  /** Map from section index → editor handle ref. */
  editorRefs: React.RefObject<Map<number, MilkdownEditorHandle>>;
}

/**
 * Find the closest ancestor (or self) with a `data-section-index` attribute.
 */
function findSectionContainer(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.sectionIndex !== undefined) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Collect all section container elements intersected by the given range,
 * in document order.
 */
function collectIntersectedSections(
  container: HTMLElement,
  range: Range,
): HTMLElement[] {
  const result: HTMLElement[] = [];
  const children = container.querySelectorAll<HTMLElement>("[data-section-index]");
  for (const child of children) {
    if (range.intersectsNode(child)) {
      result.push(child);
    }
  }
  return result;
}

/**
 * Extract markdown from a partial selection within an editor view.
 * Uses posAtDOM to map DOM range endpoints to ProseMirror positions,
 * then slices the document and serializes.
 */
function extractPartialMarkdown(
  handle: MilkdownEditorHandle,
  rangeNode: Node,
  rangeOffset: number,
  side: "start" | "end",
): string | null {
  const view = handle.getView();
  if (!view) return null;

  try {
    const domPos = view.posAtDOM(rangeNode, rangeOffset);
    if (domPos < 0) return null;

    const { doc } = view.state;
    const from = side === "start" ? domPos : 0;
    const to = side === "end" ? domPos : doc.content.size;
    const slice = doc.slice(Math.min(from, to), Math.max(from, to));

    // Wrap the slice content in a doc node for serialization
    const docNode = doc.type.create(null, slice.content);
    return proseMirrorNodeToMarkdown(docNode);
  } catch {
    return null;
  }
}

export function useCrossSectionCopy({
  containerRef,
  sections,
  editorRefs,
}: CrossSectionCopyOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleCopy(event: ClipboardEvent): void {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

      const range = selection.getRangeAt(0);

      // Find section containers at start and end of selection
      const startSection = findSectionContainer(range.startContainer);
      const endSection = findSectionContainer(range.endContainer);

      // If both endpoints are in the same section (or neither is in a section),
      // let the native/Milkdown copy handler do its thing.
      if (startSection === endSection) return;

      // Selection spans multiple sections — intercept
      const intersected = collectIntersectedSections(container!, range);
      if (intersected.length < 2) return;

      const markdownParts: string[] = [];

      for (let i = 0; i < intersected.length; i++) {
        const el = intersected[i];
        const sectionIndex = parseInt(el.dataset.sectionIndex!, 10);
        const section = sections[sectionIndex];
        if (!section) continue;

        const isFirst = i === 0;
        const isLast = i === intersected.length - 1;
        const editors = editorRefs.current;
        const handle = editors?.get(sectionIndex);

        if (isFirst && handle) {
          // Partial: from selection start to end of this section's editor
          // Note: section.content already includes the heading (prepended by backend),
          // and the ProseMirror doc also contains it, so we do NOT add headingPrefix.
          const partial = extractPartialMarkdown(
            handle,
            range.startContainer,
            range.startOffset,
            "start",
          );
          markdownParts.push(partial ?? section.content);
        } else if (isLast && handle) {
          // Partial: from start of this section's editor to selection end
          const partial = extractPartialMarkdown(
            handle,
            range.endContainer,
            range.endOffset,
            "end",
          );
          markdownParts.push(partial ?? section.content);
        } else {
          // Fully selected middle section — use full content (already includes heading)
          markdownParts.push(section.content);
        }
      }

      const markdown = markdownParts.join("\n\n");

      event.preventDefault();
      event.clipboardData?.setData("text/plain", markdown);
    }

    container.addEventListener("copy", handleCopy);
    return () => container.removeEventListener("copy", handleCopy);
  }, [containerRef, sections, editorRefs]);
}
