/**
 * Badge: canonical last editor vs “Uncommitted changes here”.
 *
 * Person = last committed/canonical attribution. When the section is in the
 * live pending/uncommitted set, replace the person line with uncommitted copy —
 * never a live writer / awareness name.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ComponentProps } from "react";
import { SummaryWhoChangedThisSection } from "../../components/SummaryWhoChangedThisSection";
import { SectionHoverProvider } from "../../contexts/SectionHoverContext";

vi.mock("../../services/api-client", () => ({
  resolveWriterId: () => "me-user",
}));

vi.mock("../../hooks/useAgeDisplay", () => ({
  useAgeDisplay: () => "5s ago",
}));

type BadgeProps = ComponentProps<typeof SummaryWhoChangedThisSection> & {
  /** When true, section has uncommitted live/CRDT work — overlay replaces the person. */
  uncommittedChanges?: boolean;
};

function renderBadge(props: BadgeProps) {
  return render(
    <SectionHoverProvider activeFragmentKey="section::alpha">
      <SummaryWhoChangedThisSection {...props} />
    </SectionHoverProvider>,
  );
}

describe("SummaryWhoChangedThisSection canonical vs uncommitted overlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("7: shows canonical person when not pending; uncommitted overlay when pending (no live writer name)", () => {
    const { rerender } = renderBadge({
      editorId: "alice",
      editorName: "Alice",
      secondsAgo: 5,
      writerType: "human",
      fragmentKey: "section::alpha",
      uncommittedChanges: false,
    });

    expect(screen.getByText("Alice")).toBeDefined();
    expect(screen.queryByText(/uncommitted changes here/i)).toBeNull();

    rerender(
      <SectionHoverProvider activeFragmentKey="section::alpha">
        <SummaryWhoChangedThisSection
          editorId="alice"
          editorName="Alice"
          secondsAgo={5}
          writerType="human"
          fragmentKey="section::alpha"
          {...{ uncommittedChanges: true }}
        />
      </SectionHoverProvider>,
    );

    expect(screen.getByText(/uncommitted changes here/i)).toBeDefined();
    expect(screen.queryByText("Alice")).toBeNull();
    // Never show a live/pending writer identity as the person line.
    expect(screen.queryByText(/Hub Writer|Replica Writer|live writer/i)).toBeNull();
  });
});
