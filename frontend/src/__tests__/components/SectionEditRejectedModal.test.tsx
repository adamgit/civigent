/**
 * `SectionEditRejectedModal` render + dismiss coverage.
 *
 * The document page renders this modal in response to a synthetic
 * `section:edit-rejected` event (see `DocumentPage.tsx` state hook). The tests
 * here drive the same state transitions in isolation: mount with an event,
 * assert the user-visible fields render, click the dismiss button, assert the
 * modal disappears.
 *
 * We do NOT assert every sentence of copy — only that each server-authored
 * field (reason, affected section, server action, guidance) shows up.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { SectionEditRejectedEvent } from "../../types/shared";
import { SectionEditRejectedModal } from "../../components/SectionEditRejectedModal";

function buildRejection(): SectionEditRejectedEvent {
  return {
    type: "section:edit-rejected",
    doc_path: "/ops/routing.md",
    rejected_by: "server",
    affected_fragments: [
      { fragment_key: "section::overview", heading_path: ["Overview"], heading: "Overview" },
    ],
    reason_code: "duplicate-sibling-heading",
    title: "Duplicate heading rejected",
    message: "Two sections would share the heading “Timeline”.",
    what_happened: "Your rename would collide with an existing sibling.",
    why_rejected: "Siblings cannot share the same heading in the current model.",
    server_action: "Your edit was reverted to the last accepted state.",
    guidance: "Use a distinct heading, or rename the sibling first.",
  };
}

describe("SectionEditRejectedModal", () => {
  it("renders the reason, affected section, server action, and guidance", () => {
    const onDismiss = vi.fn();
    render(<SectionEditRejectedModal event={buildRejection()} onDismiss={onDismiss} />);

    // Title / message.
    expect(screen.getByText("Duplicate heading rejected")).toBeTruthy();
    expect(
      screen.getByText((text) => text.includes("Two sections would share the heading")),
    ).toBeTruthy();
    // Affected section (heading path).
    expect(screen.getByText("Overview")).toBeTruthy();
    // Explanatory fields.
    expect(
      screen.getByText((text) => text.includes("collide with an existing sibling")),
    ).toBeTruthy();
    expect(
      screen.getByText((text) => text.includes("Siblings cannot share the same heading")),
    ).toBeTruthy();
    // Server action.
    expect(
      screen.getByText((text) => text.includes("reverted to the last accepted state")),
    ).toBeTruthy();
    // Guidance.
    expect(
      screen.getByText((text) => text.includes("Use a distinct heading")),
    ).toBeTruthy();
  });

  it("invokes onDismiss when the Dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<SectionEditRejectedModal event={buildRejection()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clears from the page when a container transitions state to null (same wiring as DocumentPage)", () => {
    // Mirrors the exact wiring in `DocumentPage.tsx`:
    // the page owns rejection state; `useDocumentWebSocket` calls
    // `onSectionEditRejected` to set it; the modal renders while state !== null;
    // dismiss clears state → modal unmounts. We simulate the same state
    // machine with a trivial container so this test does not depend on the
    // full DocumentPage integration surface.
    function Container({ initial }: { initial: SectionEditRejectedEvent | null }) {
      const [rejection, setRejection] = useState<SectionEditRejectedEvent | null>(initial);
      if (!rejection) return <div data-testid="no-modal">no modal</div>;
      return (
        <SectionEditRejectedModal event={rejection} onDismiss={() => setRejection(null)} />
      );
    }

    render(<Container initial={buildRejection()} />);
    // Modal is present initially.
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Explicit dismiss unmounts the modal.
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("no-modal")).toBeTruthy();
  });

  it("restores focus to the active editor when dismissed without leaving editor mode", () => {
    function Container() {
      const [rejection, setRejection] = useState<SectionEditRejectedEvent | null>(null);
      return (
        <div>
          <button type="button" data-testid="active-editor">Editor</button>
          <span data-testid="editor-mode">editor</span>
          <button type="button" onClick={() => setRejection(buildRejection())}>
            Show rejection
          </button>
          {rejection ? (
            <SectionEditRejectedModal event={rejection} onDismiss={() => setRejection(null)} />
          ) : null}
        </div>
      );
    }

    render(<Container />);
    const editor = screen.getByTestId("active-editor");
    editor.focus();
    fireEvent.click(screen.getByRole("button", { name: "Show rejection" }));

    const dismiss = screen.getByRole("button", { name: /dismiss/i });
    dismiss.focus();
    fireEvent.click(dismiss);

    expect(screen.getByTestId("editor-mode").textContent).toBe("editor");
    expect(document.activeElement).toBe(editor);
  });

  it("handles a rejection whose affected fragments list is empty without crashing", () => {
    // The server may synthesize a rejection with no per-fragment details
    // (e.g. a future validator that operates at the document level). The
    // modal must render its user-visible fields even when the list is empty.
    const eventWithNoFragments: SectionEditRejectedEvent = {
      ...buildRejection(),
      affected_fragments: [],
    };
    render(
      <SectionEditRejectedModal event={eventWithNoFragments} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText("Duplicate heading rejected")).toBeTruthy();
    // No "Affected sections" section rendered when the list is empty.
    expect(screen.queryByText(/Affected section/i)).toBeNull();
  });
});
