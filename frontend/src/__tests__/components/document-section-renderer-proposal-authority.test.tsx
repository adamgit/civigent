/**
 * Proposal draft mode must never paint/edit body via the live replica.
 *
 * Cutover will invite a “one paint path” tidy-up; this pins that proposalMode
 * keeps overlay/`section.content` authority and gates the live store off.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import { DocumentSectionRenderer } from "../../components/DocumentSectionRenderer";
import { SectionHoverProvider } from "../../contexts/SectionHoverContext";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store";
import type { DocumentSection } from "../../pages/document-page-utils";

vi.mock("../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { markdown?: string; store?: unknown; fragmentKey?: string }, _ref: unknown) => (
        <div
          data-testid="milkdown-editor"
          data-markdown={props.markdown ?? ""}
          data-has-store={props.store ? "yes" : "no"}
          data-fragment-key={props.fragmentKey}
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

function makeSection(): DocumentSection {
  return {
    heading: "Alpha",
    heading_path: ["Alpha"],
    depth: 1,
    content: `# Alpha\n${DRAFT}\n`,
    agentWritePolicy: { canWrite: true, message: "ok" },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 2,
    fragment_key: FRAG,
    section_file: "sec_alpha.md",
  } as DocumentSection;
}

function writeLiveFragment(doc: Y.Doc): void {
  doc.transact(() =>
    updateYFragment(
      doc,
      doc.getXmlFragment(FRAG),
      markdownToProseMirrorNode(`# Alpha\n${LIVE}\n`),
      { mapping: new Map(), isOMark: new Map() },
    ),
  );
}

describe("DocumentSectionRenderer proposal draft authority", () => {
  afterEach(() => {
    cleanup();
  });

  it("6: proposalMode paints/edits draft content and does not use the live store/replica body", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    writeLiveFragment(doc);
    const store = new BrowserFragmentReplicaStore(doc, awareness);
    const mouseDownPosRef = { current: null as { x: number; y: number } | null };
    const localEditSink = { recordLocalEdit: vi.fn() };

    render(
      <SectionHoverProvider activeSectionIndex={0}>
        <DocumentSectionRenderer
          section={makeSection()}
          index={0}
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
          dragOverSectionIndex={null}
          store={store}
          transport={null}
          crdtSynced
          crdtState="connected"
          transferService={null}
          proposalMode
          canEditProposalContent
          proposalScopeMutationInFlight={false}
          isReady
          localEditSink={localEditSink}
          mouseDownPosRef={mouseDownPosRef}
          onStartEditing={vi.fn()}
          onFocusSection={vi.fn()}
          onSetEditorRef={vi.fn()}
          onEditorReady={vi.fn()}
          onProposalSectionChange={vi.fn()}
          onToggleProposalSection={vi.fn()}
          onCursorExit={vi.fn()}
          onCrossSectionDrop={vi.fn()}
        />
      </SectionHoverProvider>,
    );

    const editor = screen.getByTestId("milkdown-editor");
    expect(editor.getAttribute("data-has-store")).toBe("no");
    expect(editor.getAttribute("data-markdown")).toContain(DRAFT);
    expect(editor.getAttribute("data-markdown")).not.toContain(LIVE);
    expect(screen.queryByText(new RegExp(LIVE))).toBeNull();
    expect(screen.getByText(new RegExp(DRAFT))).toBeDefined();

    awareness.destroy();
    doc.destroy();
  });

  it("563: proposalMode never routes the body through the live replica (paint or binding)", () => {
    // The live replica offers a LIVE body via both paint and binding; proposal mode
    // must use NEITHER — display/edit stays on the draft overlay `section.content`.
    const livePaintMarkdown = vi.fn(() => `# Alpha\n${LIVE}\n`);
    const getLiveBinding = vi.fn(() => ({
      doc: new Y.Doc(),
      awareness: {} as unknown as Awareness,
      fragmentKey: FRAG,
    }));
    const mouseDownPosRef = { current: null as { x: number; y: number } | null };
    const localEditSink = { recordLocalEdit: vi.fn() };
    const onProposalSectionChange = vi.fn();

    render(
      <SectionHoverProvider activeSectionIndex={0}>
        <DocumentSectionRenderer
          section={makeSection()}
          index={0}
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
          dragOverSectionIndex={null}
          store={null}
          transport={null}
          crdtSynced
          crdtState="connected"
          transferService={null}
          proposalMode
          canEditProposalContent
          proposalScopeMutationInFlight={false}
          isReady
          livePaintMarkdown={livePaintMarkdown}
          getLiveBinding={getLiveBinding}
          localEditSink={localEditSink}
          mouseDownPosRef={mouseDownPosRef}
          onStartEditing={vi.fn()}
          onFocusSection={vi.fn()}
          onSetEditorRef={vi.fn()}
          onEditorReady={vi.fn()}
          onProposalSectionChange={onProposalSectionChange}
          onToggleProposalSection={vi.fn()}
          onCursorExit={vi.fn()}
          onCrossSectionDrop={vi.fn()}
        />
      </SectionHoverProvider>,
    );

    // The replica body path is NEVER consulted in proposal mode.
    expect(livePaintMarkdown).not.toHaveBeenCalled();
    expect(getLiveBinding).not.toHaveBeenCalled();

    // The editor paints the draft overlay body only.
    const editor = screen.getByTestId("milkdown-editor");
    expect(editor.getAttribute("data-has-store")).toBe("no");
    expect(editor.getAttribute("data-markdown")).toContain(DRAFT);
    expect(editor.getAttribute("data-markdown")).not.toContain(LIVE);
    expect(screen.queryByText(new RegExp(LIVE))).toBeNull();
  });
});
