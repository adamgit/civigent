/**
 * useCrossSectionCopy — intercepts Ctrl-C when the selection reaches beyond a
 * single section editor and writes clean markdown to the clipboard.
 *
 * The listener lives on `document`, not the sections container: browsers fire
 * `copy` at the selection's START node, so a drag anchored on page chrome
 * (topbar, header links) never bubbles through the container. Only selections
 * that intersect at least one section wrapper are intercepted; an endpoint
 * outside any section copies that boundary section whole.
 *
 * Selections within a single section are left to Milkdown's native copy handler.
 *
 * Selected DOM wrappers resolve to sections by FRAGMENT IDENTITY: each real
 * document section wrapper carries `data-document-section` + `data-fragment-key`,
 * and the hook joins those keys against the caller's current render rows. There
 * is deliberately NO positional (`data-section-index` → `sections[index]`) join —
 * after live topology diverges from a cold array, position is not identity.
 */

import { useEffect } from "react";
import { proseMirrorNodeToMarkdown } from "@ks/milkdown-serializer";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";

export interface CrossSectionCopySection {
  fragment_key: string;
  /**
   * The section's CURRENT display markdown, as the page paints it: proposal
   * overlay body while drafting, live replica body when live editing is
   * authoritative, else the cold/canonical seed. The page's display selector
   * encodes that precedence; this hook copies what the user sees.
   */
  displayMarkdown: string;
}

export interface CrossSectionCopyOptions {
  /** Ref to the container div that wraps all section elements. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Current render rows with their display markdown, keyed by fragment_key. */
  displayRows: ReadonlyArray<CrossSectionCopySection>;
  /** Map from section `fragment_key` → editor handle ref. */
  editorRefs: React.RefObject<Map<string, MilkdownEditorHandle>>;
  /**
   * Live-replica body reader — fallback ONLY for a wrapper whose fragment key
   * has no row in `displayRows` (e.g. transient structural drift between DOM
   * and render state). The row's display markdown wins when present.
   */
  getLiveMarkdown?: (fragmentKey: string) => string | undefined;
}

/** The selector for REAL document section wrappers (never arbitrary descendants
 *  that happen to expose a fragment key). */
const SECTION_WRAPPER_SELECTOR = "[data-document-section][data-fragment-key]";

/**
 * Find the closest ancestor (or self) that is a document section wrapper.
 */
function findSectionContainer(node: Node): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    if (
      el instanceof HTMLElement
      && el.hasAttribute("data-document-section")
      && el.dataset.fragmentKey !== undefined
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Collect all section wrapper elements intersected by the given range,
 * in document order.
 */
function collectIntersectedSections(
  container: HTMLElement,
  range: Range,
): HTMLElement[] {
  const result: HTMLElement[] = [];
  const children = container.querySelectorAll<HTMLElement>(SECTION_WRAPPER_SELECTOR);
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
  displayRows,
  editorRefs,
  getLiveMarkdown,
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

      // Both endpoints inside the same section: Milkdown's own copy handler owns it.
      if (startSection !== null && startSection === endSection) return;

      // Everything else is ours IF the selection touches this page's sections at
      // all — spanning sections, or anchored outside the document body (topbar,
      // page chrome) and sweeping through it. A selection touching no section
      // (copying topbar text, a modal, the sidebar) stays native.
      const intersected = collectIntersectedSections(container!, range);
      if (intersected.length === 0) return;

      // Join wrappers to rows by fragment identity ONLY.
      const rowByFragmentKey = new Map(displayRows.map((s) => [s.fragment_key, s]));

      // A section whose body this page cannot name would be copied as a silent
      // blank gap after preventDefault discarded what the user could see. Hand
      // the whole copy back to the browser instead — the rendered DOM is right.
      const bodyByFragmentKey = new Map<string, string>();
      for (const el of intersected) {
        const fragmentKey = el.dataset.fragmentKey!;
        const body = rowByFragmentKey.get(fragmentKey)?.displayMarkdown
          ?? getLiveMarkdown?.(fragmentKey);
        if (body === undefined) return;
        bodyByFragmentKey.set(fragmentKey, body);
      }

      const markdownParts: string[] = [];

      for (let i = 0; i < intersected.length; i++) {
        const el = intersected[i];
        const fragmentKey = el.dataset.fragmentKey!;
        const fallback = bodyByFragmentKey.get(fragmentKey)!;

        const isFirst = i === 0;
        const isLast = i === intersected.length - 1;
        const handle = editorRefs.current?.get(fragmentKey);

        if (isFirst && startSection === el && handle) {
          // Partial: from selection start to end of this section's editor.
          // The fragment content already includes the heading, so no prefix.
          // An endpoint outside any section (startSection null) skips this and
          // copies the boundary section whole via the fallback below.
          const partial = extractPartialMarkdown(
            handle,
            range.startContainer,
            range.startOffset,
            "start",
          );
          markdownParts.push(partial ?? fallback);
        } else if (isLast && endSection === el && handle) {
          // Partial: from start of this section's editor to selection end
          const partial = extractPartialMarkdown(
            handle,
            range.endContainer,
            range.endOffset,
            "end",
          );
          markdownParts.push(partial ?? fallback);
        } else {
          // Fully selected middle section, or a boundary section whose selection
          // endpoint sits outside any section — full content (includes heading)
          markdownParts.push(fallback);
        }
      }

      const markdown = markdownParts.join("\n\n");

      event.preventDefault();
      event.clipboardData?.setData("text/plain", markdown);
    }

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, [containerRef, displayRows, editorRefs, getLiveMarkdown]);
}
