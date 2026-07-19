/**
 * Proposal draft mode must never paint/edit body via the live replica.
 *
 * Render rows are body-free: every painted or seeded body flows through the
 * page's `getDisplayMarkdown` selector (which, in proposal mode, resolves the
 * draft overlay / cold seed — never the replica). The renderer's own contract,
 * pinned here: in proposal mode the Milkdown editor is seeded with the selector
 * markdown and the live binding path (`getLiveBinding`) is NEVER consulted.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { DocumentSectionRenderer } from "../../components/DocumentSectionRenderer";
import { SectionHoverProvider } from "../../contexts/SectionHoverContext";
import { SectionId, type RenderSectionRef } from "../../types/live-sections";

vi.mock("../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { markdown?: string; binding?: unknown }, _ref: unknown) => (
        <div
          data-testid="milkdown-editor"
          data-markdown={props.markdown ?? ""}
          data-has-binding={props.binding ? "yes" : "no"}
        >
          {props.markdown ?? ""}
        </div>
      ),
    ),
  };
});

vi.mock("../../services/api-client", () => ({
  resolveWriterId: () => "test-user",
}));

const FRAG = "section::alpha";
const DRAFT = "PROPOSAL_DRAFT_BODY_ONLY";
const LIVE = "LIVE_REPLICA_BODY_MUST_NOT_APPEAR";

function makeSection(): RenderSectionRef {
  return { id: SectionId.brand(FRAG), headingPath: ["Alpha"] };
}

function renderProposalSection(opts: {
  getDisplayMarkdown: (ref: RenderSectionRef) => string;
  getLiveBinding?: () => { doc: Y.Doc; awareness: Awareness; fragmentKey: string } | undefined;
  onProposalSectionChange?: (headingPath: readonly string[], markdown: string) => void;
}) {
  const mouseDownPosRef = { current: null as { x: number; y: number } | null };
  const localEditSink = { recordLocalEdit: vi.fn() };
  return render(
    <SectionHoverProvider activeFragmentKey={FRAG}>
      <DocumentSectionRenderer
        section={makeSection()}
        fragmentKey={FRAG}
        isFocused
        hasEditor
        isInProposal
        proposalConflictReason={null}
        isLockedByOtherHuman={false}
        crdtBlocked={false}
        publishPaused={false}
        highlightLabel={null}
        injectedByWriter={null}
        hasRemotePresence={false}
        dragOverFragmentKey={null}
        crdtState="connected"
        transferService={null}
        proposalMode
        canEditProposalContent
        proposalScopeMutationInFlight={false}
        isReady
        getDisplayMarkdown={opts.getDisplayMarkdown}
        getLiveBinding={opts.getLiveBinding}
        localEditSink={localEditSink}
        mouseDownPosRef={mouseDownPosRef}
        onStartEditing={vi.fn()}
        onFocusSection={vi.fn()}
        onSetEditorRef={vi.fn()}
        onEditorReady={vi.fn()}
        onProposalSectionChange={opts.onProposalSectionChange ?? vi.fn()}
        onToggleProposalSection={vi.fn()}
        onCursorExit={vi.fn()}
        onCrossSectionDrop={vi.fn()}
      />
    </SectionHoverProvider>,
  );
}

describe("DocumentSectionRenderer proposal draft authority", () => {
  afterEach(() => {
    cleanup();
  });

  it("6: proposalMode paints/edits the selector's draft content, with no live binding", () => {
    renderProposalSection({
      getDisplayMarkdown: () => `# Alpha\n${DRAFT}\n`,
    });

    const editor = screen.getByTestId("milkdown-editor");
    expect(editor.getAttribute("data-has-binding")).toBe("no");
    expect(editor.getAttribute("data-markdown")).toContain(DRAFT);
    expect(editor.getAttribute("data-markdown")).not.toContain(LIVE);
    expect(screen.queryByText(new RegExp(LIVE))).toBeNull();
    expect(screen.getByText(new RegExp(DRAFT))).toBeDefined();
  });

  it("563: proposalMode never consults the live binding path", () => {
    // Even when a live binding is available, proposal mode must NOT bind the
    // editor to the replica — draft bodies stay on the overlay authority.
    const getLiveBinding = vi.fn(() => ({
      doc: new Y.Doc(),
      awareness: {} as unknown as Awareness,
      fragmentKey: FRAG,
    }) as unknown as import("../../services/live-section-replica").LiveEditorBinding);

    renderProposalSection({
      getDisplayMarkdown: () => `# Alpha\n${DRAFT}\n`,
      getLiveBinding,
    });

    expect(getLiveBinding).not.toHaveBeenCalled();

    const editor = screen.getByTestId("milkdown-editor");
    expect(editor.getAttribute("data-has-binding")).toBe("no");
    expect(editor.getAttribute("data-markdown")).toContain(DRAFT);
    expect(editor.getAttribute("data-markdown")).not.toContain(LIVE);
    expect(screen.queryByText(new RegExp(LIVE))).toBeNull();
  });
});
