/**
 * Cross-section copy (spec 05 §Editing UX; clean-markdown clipboard).
 *
 * When a selection spans MULTIPLE section editors, Ctrl-C is intercepted and the
 * clipboard receives clean markdown (headings + body, joined, no UI chrome).
 * When the selection is within a SINGLE section, the handler defers to Milkdown's
 * built-in clipboard (no preventDefault, no clipboard write).
 *
 * Not a cross-section MOVE test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCrossSectionCopy } from "../../hooks/useCrossSectionCopy";

const sections = [
  { heading_path: ["Overview"], heading: "Overview", depth: 1, content: "## Overview\n\nOverview body." },
  { heading_path: ["Timeline"], heading: "Timeline", depth: 1, content: "## Timeline\n\nTimeline body." },
];

let container: HTMLDivElement;
let s0: HTMLDivElement;
let s1: HTMLDivElement;

function setupDom() {
  container = document.createElement("div");
  s0 = document.createElement("div");
  s0.dataset.sectionIndex = "0";
  s0.textContent = "Overview body";
  s1 = document.createElement("div");
  s1.dataset.sectionIndex = "1";
  s1.textContent = "Timeline body";
  container.append(s0, s1);
  document.body.append(container);
}

function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function dispatchCopy(): { prevented: boolean; setData: ReturnType<typeof vi.fn> } {
  const setData = vi.fn();
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { setData } });
  container.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, setData };
}

describe("cross-section copy (spec 05)", () => {
  beforeEach(() => setupDom());
  afterEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("copies clean markdown when the selection spans multiple sections", () => {
    const containerRef = { current: container };
    const editorRefs = { current: new Map() }; // no live editors → full section content used
    renderHook(() => useCrossSectionCopy({ containerRef, sections, editorRefs }));

    selectRange(s0.firstChild!, 0, s1.firstChild!, (s1.firstChild as Text).length);
    const { prevented, setData } = dispatchCopy();

    expect(prevented).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "## Overview\n\nOverview body.\n\n## Timeline\n\nTimeline body.",
    );
  });

  it("defers to Milkdown's built-in clipboard for an intra-section selection", () => {
    const containerRef = { current: container };
    const editorRefs = { current: new Map() };
    renderHook(() => useCrossSectionCopy({ containerRef, sections, editorRefs }));

    // Selection entirely within section 0.
    selectRange(s0.firstChild!, 0, s0.firstChild!, 4);
    const { prevented, setData } = dispatchCopy();

    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });
});
