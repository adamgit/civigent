import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { WsDiagnosticsConsole } from "../../components/WsDiagnosticsConsole";
import { recordWsDiag, clearWsDiag } from "../../services/ws-diagnostics";

describe("WsDiagnosticsConsole", () => {
  beforeEach(() => {
    clearWsDiag();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render when closed", () => {
    const { container } = render(<WsDiagnosticsConsole open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders entries and live-updates when a new event is recorded", () => {
    recordWsDiag({ source: "ws-frame", type: "catalog:changed", summary: "initial event" });
    render(<WsDiagnosticsConsole open onClose={() => {}} />);
    expect(screen.getByText(/initial event/)).toBeDefined();

    act(() => {
      recordWsDiag({ source: "ws-frame", type: "content:committed", summary: "second event" });
    });
    expect(screen.getByText(/second event/)).toBeDefined();
  });

  it("expands a row to show the full JSON payload on click, collapses on second click", () => {
    recordWsDiag({
      source: "ws-frame",
      type: "catalog:changed",
      summary: "payload-expand-me",
      payload: { added_doc_paths: ["/foo/bar.md"] },
    });
    render(<WsDiagnosticsConsole open onClose={() => {}} />);

    const rowButton = screen.getByText(/payload-expand-me/).closest("button")!;

    fireEvent.click(rowButton);
    expect(screen.getByText(/"added_doc_paths"/)).toBeDefined();

    fireEvent.click(rowButton);
    expect(screen.queryByText(/"added_doc_paths"/)).toBeNull();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<WsDiagnosticsConsole open onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the Close button is clicked", () => {
    const onClose = vi.fn();
    render(<WsDiagnosticsConsole open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close ws diagnostics console/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("clears the buffer when Clear is clicked", () => {
    recordWsDiag({ source: "ws-frame", type: "x", summary: "sample-entry" });
    render(<WsDiagnosticsConsole open onClose={() => {}} />);
    expect(screen.getByText(/sample-entry/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/sample-entry/)).toBeNull();
    expect(screen.getByText(/no events captured yet/i)).toBeDefined();
  });

  it("copies the full serialized buffer to the clipboard on 'Copy all as JSON'", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    recordWsDiag({
      source: "ws-frame",
      type: "catalog:changed",
      summary: "hi",
      payload: { added_doc_paths: ["/x.md"] },
    });
    render(<WsDiagnosticsConsole open onClose={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /copy all as json/i }));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0]![0] as string;
    const parsed = JSON.parse(payload) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
  });
});
