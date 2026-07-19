import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSectionDragDrop } from "../../hooks/useSectionDragDrop";
import type { SectionTransferService } from "../../services/section-transfer";

function makeDragEvent(type: string, text = "Dragged static text"): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  const dataTransfer = {
    dropEffect: "none",
    getData: vi.fn((format: string) => (format === "text/plain" ? text : "")),
  };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: 10 });
  Object.defineProperty(event, "clientY", { value: 10 });
  return event;
}

describe("useSectionDragDrop", () => {
  it("keeps a static drag source by fragment identity across drag-over rerenders", async () => {
    const container = document.createElement("div");
    const source = document.createElement("div");
    source.dataset.fragmentKey = "section::source";
    source.setAttribute("data-document-section", "");
    source.textContent = "Source";
    const target = document.createElement("div");
    target.dataset.fragmentKey = "section::target";
    target.setAttribute("data-document-section", "");
    target.textContent = "Target";
    container.append(source, target);
    document.body.append(container);

    const execute = vi.fn(async () => ({
      success: true,
      sourceModified: false,
      targetModified: true,
    }));
    const transferService = {
      canDrop: vi.fn(() => ({ allowed: true })),
      execute,
    } as unknown as SectionTransferService;
    const headingPaths = new Map([
      ["section::source", ["Source"]],
      ["section::target", ["Target"]],
    ]);
    const containerRef = { current: container };

    renderHook(() => useSectionDragDrop({
      containerRef,
      transferService,
      getHeadingPath: (fk) => headingPaths.get(fk) ?? null,
      hasEditor: () => false,
      getSectionContent: () => "Target markdown",
    }));

    act(() => {
      source.dispatchEvent(makeDragEvent("dragstart"));
    });
    await act(async () => {
      target.dispatchEvent(makeDragEvent("dragover"));
    });
    await act(async () => {
      target.dispatchEvent(makeDragEvent("drop"));
      await Promise.resolve();
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const transfer = execute.mock.calls[0]?.[0];
    expect(transfer.sourceFragmentKey).toBe("section::source");
    expect(transfer.targetFragmentKey).toBe("section::target");
  });
});
