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
  { heading_path: ["Overview"], heading: "Overview", depth: 1, displayMarkdown: "## Overview\n\nOverview body.", fragment_key: "section::overview" },
  { heading_path: ["Timeline"], heading: "Timeline", depth: 1, displayMarkdown: "## Timeline\n\nTimeline body.", fragment_key: "section::timeline" },
];

let container: HTMLDivElement;
let s0: HTMLDivElement;
let s1: HTMLDivElement;

function setupDom(
  rows: Array<{
    text: string;
    sectionIndex?: string;
    fragmentKey?: string;
    documentSection?: boolean;
  }> = [
    { text: "Overview body", fragmentKey: "section::overview", documentSection: true },
    { text: "Timeline body", fragmentKey: "section::timeline", documentSection: true },
  ],
) {
  container = document.createElement("div");
  const elements = rows.map((row) => {
    const el = document.createElement("div");
    if (row.sectionIndex !== undefined) el.dataset.sectionIndex = row.sectionIndex;
    if (row.fragmentKey !== undefined) el.dataset.fragmentKey = row.fragmentKey;
    if (row.documentSection) el.setAttribute("data-document-section", "");
    el.textContent = row.text;
    return el;
  });
  [s0, s1] = elements as [HTMLDivElement, HTMLDivElement];
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
    renderHook(() => useCrossSectionCopy({ containerRef, displayRows: sections, editorRefs }));

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
    renderHook(() => useCrossSectionCopy({ containerRef, displayRows: sections, editorRefs }));

    // Selection entirely within section 0.
    selectRange(s0.firstChild!, 0, s0.firstChild!, 4);
    const { prevented, setData } = dispatchCopy();

    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it("copies by wrapper fragment identity when live render order differs from cold section order", () => {
    document.body.innerHTML = "";
    setupDom([
      {
        text: "Timeline body",
        sectionIndex: "0",
        fragmentKey: "section::timeline",
        documentSection: true,
      },
      {
        text: "Overview body",
        sectionIndex: "1",
        fragmentKey: "section::overview",
        documentSection: true,
      },
    ]);
    const containerRef = { current: container };
    const editorRefs = { current: new Map() };
    renderHook(() => useCrossSectionCopy({ containerRef, displayRows: sections, editorRefs }));

    selectRange(s0.firstChild!, 0, s1.firstChild!, (s1.firstChild as Text).length);
    const { prevented, setData } = dispatchCopy();

    expect(prevented).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "## Timeline\n\nTimeline body.\n\n## Overview\n\nOverview body.",
    );
  });

  it("uses proposal overlay markdown ahead of canonical live markdown for copied proposal sections", () => {
    document.body.innerHTML = "";
    setupDom([
      {
        text: "Overview proposal body",
        sectionIndex: "0",
        fragmentKey: "section::overview",
        documentSection: true,
      },
      {
        text: "Timeline proposal body",
        sectionIndex: "1",
        fragmentKey: "section::timeline",
        documentSection: true,
      },
    ]);
    const proposalRenderSections = [
      {
        ...sections[0],
        displayMarkdown: "## Overview\n\nProposal overlay overview.",
      },
      {
        ...sections[1],
        displayMarkdown: "## Timeline\n\nProposal overlay timeline.",
      },
    ];
    const getLiveMarkdown = (fragmentKey: string): string | undefined => {
      if (fragmentKey === "section::overview") return "## Overview\n\nCanonical live overview.";
      if (fragmentKey === "section::timeline") return "## Timeline\n\nCanonical live timeline.";
      return undefined;
    };
    const containerRef = { current: container };
    const editorRefs = { current: new Map() };
    renderHook(() => useCrossSectionCopy({
      containerRef,
      displayRows: proposalRenderSections,
      editorRefs,
      getLiveMarkdown,
    }));

    selectRange(s0.firstChild!, 0, s1.firstChild!, (s1.firstChild as Text).length);
    const { prevented, setData } = dispatchCopy();

    expect(prevented).toBe(true);
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "## Overview\n\nProposal overlay overview.\n\n## Timeline\n\nProposal overlay timeline.",
    );
  });
});
