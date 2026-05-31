/**
 * WS-6: caret capture / clamp / restore for cross-section moves.
 *
 * The move re-seeds the moved fragment (re-minting structs), so the caret is
 * recovered by CONTENT OFFSET on the stable fragment key. These tests pin the
 * pure capture + clamp + restore behavior with a minimal mock view (no browser).
 */

import { describe, it, expect, vi } from "vitest";

// Stub TextSelection.create so restore can be exercised with a mock view (no
// real ProseMirror doc / resolve()).
vi.mock("@milkdown/prose/state", () => ({
  TextSelection: { create: (_doc: unknown, anchor: number, head: number) => ({ __sel: true, anchor, head }) },
}));

import {
  captureCaretOffsets,
  clampCaretOffsets,
  restoreCaretOffsets,
  type CaretEditorView,
} from "../../services/caret-recovery.js";

function mockView(opts: {
  focused: boolean;
  anchor?: number;
  head?: number;
  docSize?: number;
}): { view: CaretEditorView; dispatched: unknown[]; focusCalls: number; setSelectionArgs: unknown[] } {
  const dispatched: unknown[] = [];
  const setSelectionArgs: unknown[] = [];
  let focusCalls = 0;
  const view = {
    hasFocus: () => opts.focused,
    focus: () => { focusCalls += 1; },
    state: {
      selection: { anchor: opts.anchor ?? 0, head: opts.head ?? 0 },
      doc: { content: { size: opts.docSize ?? 100 } },
      tr: { setSelection: (sel: unknown) => { setSelectionArgs.push(sel); return { __tr: true }; } },
    },
    dispatch: (tr: unknown) => { dispatched.push(tr); },
  } as unknown as CaretEditorView;
  return {
    view,
    dispatched,
    get focusCalls() { return focusCalls; },
    setSelectionArgs,
  };
}

describe("caret-recovery (WS-6)", () => {
  it("captures the selection offsets only when the view holds focus", () => {
    const focused = mockView({ focused: true, anchor: 5, head: 9 });
    expect(captureCaretOffsets(focused.view)).toEqual({ anchor: 5, head: 9 });

    const blurred = mockView({ focused: false, anchor: 5, head: 9 });
    expect(captureCaretOffsets(blurred.view)).toBeNull();

    expect(captureCaretOffsets(null)).toBeNull();
    expect(captureCaretOffsets(undefined)).toBeNull();
  });

  it("clamps offsets into the (possibly shrunk) document bounds", () => {
    expect(clampCaretOffsets({ anchor: 50, head: 60 }, 100)).toEqual({ anchor: 50, head: 60 });
    expect(clampCaretOffsets({ anchor: 200, head: 300 }, 40)).toEqual({ anchor: 40, head: 40 });
    expect(clampCaretOffsets({ anchor: -5, head: 2 }, 100)).toEqual({ anchor: 0, head: 2 });
  });

  it("restore is a no-op when there is no view or no captured offsets", () => {
    const v = mockView({ focused: true });
    restoreCaretOffsets(v.view, null);
    expect(v.dispatched).toHaveLength(0);
    restoreCaretOffsets(null, { anchor: 1, head: 1 });
    // (no throw)
  });

  it("restore dispatches a clamped selection and focuses the view", () => {
    // TextSelection.create needs a real PM doc; stub it so we exercise the wiring
    // (clamp → setSelection → dispatch → focus) without a full ProseMirror doc.
    const v = mockView({ focused: true, docSize: 30 });
    restoreCaretOffsets(v.view, { anchor: 999, head: 999 });
    expect(v.setSelectionArgs).toHaveLength(1);
    expect(v.dispatched).toHaveLength(1);
    expect(v.focusCalls).toBe(1);
  });
});
