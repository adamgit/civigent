/**
 * Retarget pending caret target (fix-caret-loss A3):
 *  - a retarget target survives the bootstrap-null clearing effect
 *  - it waits until the destination editor is READY, then applies via
 *    focusAtPos with the position resolved against the destination doc
 *  - edge targets (cursor-exit) keep today's behavior
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";
import { Schema } from "@milkdown/prose/model";
import { useSectionFocus } from "../../hooks/useSectionFocus";
import type { MilkdownEditorHandle } from "../../components/MilkdownEditor";
import { SectionId, type RenderSectionRef } from "../../types/live-sections";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
    text: { group: "inline" },
  },
});

const destDoc = schema.node("doc", null, [
  schema.node("heading", { level: 2 }, [schema.text("Second")]),
  schema.node("paragraph", null, [schema.text("promoted body")]),
]);

const SECTIONS: readonly RenderSectionRef[] = [
  { id: SectionId.brand("section::overview"), headingPath: ["Overview"] },
  { id: SectionId.brand("section::second"), headingPath: ["Second"] },
];

function makeHandle(): MilkdownEditorHandle & { focusAtPosCalls: number[] } {
  const focusAtPosCalls: number[] = [];
  return {
    focusAtPosCalls,
    getMarkdown: () => "",
    getActiveHeadingPath: () => [],
    focus: vi.fn(),
    focusAtCoords: vi.fn(),
    focusAtPos: (pos: number) => {
      focusAtPosCalls.push(pos);
    },
    getView: () => ({ state: { doc: destDoc } }) as never,
  };
}

function setup(initialReady: Set<string>) {
  const handle = makeHandle();
  return {
    handle,
    hook: renderHook(
      ({ readyEditors }: { readyEditors: Set<string> }) => {
        const editorRefs = useRef(new Map([["section::second", handle as MilkdownEditorHandle]])) as
          MutableRefObject<Map<string, MilkdownEditorHandle>>;
        return useSectionFocus({
          sections: SECTIONS,
          canFocusSection: () => true,
          publishViewingSection: () => {},
          readyEditors,
          editorRefs,
        });
      },
      { initialProps: { readyEditors: initialReady } },
    ),
  };
}

describe("useSectionFocus retarget caret target", () => {
  it("survives bootstrap-null clearing and applies once the destination editor is ready", async () => {
    const { handle, hook } = setup(new Set<string>());

    act(() => {
      hook.result.current.setBootstrapFocusedSectionIndex(1);
    });
    act(() => {
      hook.result.current.setRetargetCaretTarget({
        fragmentKey: "section::second",
        position: "retarget",
        placement: {
          offsetInBlock: "Second\npromoted ".length,
          fingerprint: { before: "", after: "" },
        },
      });
    });

    act(() => {
      hook.result.current.setBootstrapFocusedSectionIndex(null);
    });
    expect(hook.result.current.pendingCaretTargetRef.current).not.toBeNull();
    expect(hook.result.current.pendingCaretTargetRef.current?.position).toBe("retarget");
    expect(handle.focusAtPosCalls).toHaveLength(0);

    hook.rerender({ readyEditors: new Set(["section::second"]) });

    await waitFor(() => expect(handle.focusAtPosCalls).toHaveLength(1));
    const headingSize = destDoc.child(0).nodeSize;
    expect(handle.focusAtPosCalls[0]).toBe(headingSize + 1 + "promoted ".length);
    expect(hook.result.current.pendingCaretTargetRef.current).toBeNull();
  });

  it("edge target from cursor-exit keeps today's behavior (cleared on bootstrap-null)", () => {
    const { hook } = setup(new Set<string>());

    act(() => {
      hook.result.current.handleCursorExit(0, "down");
    });
    expect(hook.result.current.pendingCaretTargetRef.current).toEqual({
      fragmentKey: "section::second",
      position: "start",
    });

    act(() => {
      hook.result.current.setBootstrapFocusedSectionIndex(null);
    });
    expect(hook.result.current.pendingCaretTargetRef.current).toBeNull();
  });
});
