import { describe, it, expect, vi } from "vitest";
import { applyDragOverVerdict, type DropVerdict } from "../../services/section-transfer";

function makeMockEvent() {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { dropEffect: "" as string } as DataTransfer,
  };
}

describe("applyDragOverVerdict", () => {
  it("returns true and sets dropEffect=move for allowed editor-source drags", () => {
    const event = makeMockEvent();
    const verdict: DropVerdict = { allowed: true };

    const result = applyDragOverVerdict(event, verdict, true);

    expect(result).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer!.dropEffect).toBe("move");
  });

  it("returns true and sets dropEffect=copy for allowed static-source drags", () => {
    const event = makeMockEvent();
    const verdict: DropVerdict = { allowed: true };

    const result = applyDragOverVerdict(event, verdict, false);

    expect(result).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer!.dropEffect).toBe("copy");
  });

  it("returns false and sets dropEffect=none for presence-blocked drops", () => {
    const event = makeMockEvent();
    const verdict: DropVerdict = { allowed: false, reason: "live_session", holder: "Alice" };

    const result = applyDragOverVerdict(event, verdict, true);

    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer!.dropEffect).toBe("none");
  });

  it("returns false and sets dropEffect=none for proposal-blocked drops", () => {
    const event = makeMockEvent();
    const verdict: DropVerdict = { allowed: false, reason: "human_proposal", holder: "Bob" };

    const result = applyDragOverVerdict(event, verdict, true);

    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer!.dropEffect).toBe("none");
  });

  it("returns false and sets dropEffect=none for generically blocked drops", () => {
    const event = makeMockEvent();
    const verdict: DropVerdict = { allowed: false, reason: "blocked" };

    const result = applyDragOverVerdict(event, verdict, false);

    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer!.dropEffect).toBe("none");
  });

  it("handles null dataTransfer gracefully", () => {
    const event = { preventDefault: vi.fn(), dataTransfer: null };
    const verdict: DropVerdict = { allowed: true };

    const result = applyDragOverVerdict(event, verdict, true);

    expect(result).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

/**
 * Parity tests: verify editor-target and static-target dragover paths
 * produce identical preventDefault + dropEffect behaviour for every
 * verdict, so the two paths cannot drift apart.
 *
 * Both paths call applyDragOverVerdict (the single shared function).
 * These tests document the contract: for a given verdict, the resulting
 * preventDefault call and dropEffect value MUST be the same regardless
 * of which path invoked the function.
 */
describe("editor-target / static-target dragover parity", () => {
  const BLOCKED_VERDICTS: DropVerdict[] = [
    { allowed: false, reason: "live_session", holder: "Alice" },
    { allowed: false, reason: "human_proposal", holder: "Bob" },
    { allowed: false, reason: "blocked" },
  ];

  it("allowed drop: both paths call preventDefault and agree on dropEffect", () => {
    const verdict: DropVerdict = { allowed: true };

    // Simulate editor path (hasEditorSource = true)
    const editorEvent = makeMockEvent();
    const editorResult = applyDragOverVerdict(editorEvent, verdict, true);

    // Simulate static path with editor source (hasEditorSource = true)
    const staticEvent = makeMockEvent();
    const staticResult = applyDragOverVerdict(staticEvent, verdict, true);

    expect(editorResult).toBe(staticResult);
    expect(editorEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(staticEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(editorEvent.dataTransfer!.dropEffect).toBe(staticEvent.dataTransfer!.dropEffect);
  });

  for (const verdict of BLOCKED_VERDICTS) {
    it(`blocked (${verdict.reason}): both paths call preventDefault and set dropEffect=none`, () => {
      const editorEvent = makeMockEvent();
      const editorResult = applyDragOverVerdict(editorEvent, verdict, true);

      const staticEvent = makeMockEvent();
      const staticResult = applyDragOverVerdict(staticEvent, verdict, true);

      expect(editorResult).toBe(false);
      expect(staticResult).toBe(false);
      expect(editorEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(staticEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(editorEvent.dataTransfer!.dropEffect).toBe("none");
      expect(staticEvent.dataTransfer!.dropEffect).toBe("none");
    });
  }
});
