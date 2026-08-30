/**
 * Fragment-key readiness identity (spec 05 §Editing UX; duplicate-render fix).
 *
 * Regression for the persistent duplicate + blur after a structural split: editor
 * readiness used to be keyed by POSITIONAL index, so when a split shifted a
 * section's index React preserved its Milkdown editor (keyed by `fragment_key`)
 * while `isReady = readyEditors.has(index)` got stuck false at the new index —
 * leaving the static `doc-prose` underlayer composited under the live editor
 * forever. With readiness keyed by `fragment_key`, a ready section keeps its
 * `isReady` across an index shift, so the underlayer unmounts as intended.
 *
 * The underlayer is the diagnostic surface: when an editor is ready its static
 * ReactMarkdown preview ("<heading> body") is NOT rendered; when it is not ready
 * the preview renders beneath the absolute-positioned editor.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Mock MilkdownEditor so a mounted editor is observable and never renders the
// section body itself (so any "<heading> body" text comes from the underlayer).
vi.mock("../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { binding?: { fragmentKey?: string } }, _ref: unknown) => (
        <div data-testid={`editor-${props.binding?.fragmentKey}`}>editor</div>
      ),
    ),
  };
});

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { DocumentCanvas } from "../../components/DocumentCanvas";
import { SectionHoverProvider } from "../../contexts/SectionHoverContext";
import { SectionId, type RenderSectionRef } from "../../types/live-sections";

function makeSection(file: string, heading: string): RenderSectionRef {
  return {
    id: SectionId.brand(`section::${file}`),
    headingPath: [heading],
  };
}

function displayMarkdown(ref: RenderSectionRef): string {
  return `${ref.headingPath[ref.headingPath.length - 1] ?? ""} body`;
}

// Mount gate: live editors require a LiveEditorBinding; tests fake the opaque
// capability by casting the internal attach shape.
const sharedDoc = new Y.Doc();
const sharedAwareness = new Awareness(sharedDoc);
const getLiveBinding = (fk: string) =>
  ({ doc: sharedDoc, awareness: sharedAwareness, fragmentKey: fk }) as unknown as
    import("../../services/live-section-replica").LiveEditorBinding;

function renderCanvas(
  sections: RenderSectionRef[],
  focusedSectionIndex: number,
  readyEditors: Set<string>,
) {
  const focusedFragmentKey =
    sections[focusedSectionIndex] ? SectionId.text(sections[focusedSectionIndex].id) : null;
  return render(
    <SectionHoverProvider activeFragmentKey={focusedFragmentKey}>
      <DocumentCanvas
        sections={sections}
        sectionsLoading={false}
        focusedFragmentKey={focusedFragmentKey}
        proposalMode={false}
        canEditProposalScope={false}
        canEditProposalContent={false}
        proposalScopeMutationInFlight={false}
        selectedProposalSectionKeys={new Set()}
        proposalSectionConflicts={new Map()}
        decodedDocPath="/test/doc.md"
        recentlyChangedByLabel={new Map()}
        injectedByLabel={new Map()}
        dragOverFragmentKey={null}
        isSectionBlocked={() => false}
        publishPaused={false}
        crdtState="connected"
        transferService={null}
        readyEditors={readyEditors}
        getDisplayMarkdown={displayMarkdown}
        getFragmentVersion={() => 0}
        getLiveBinding={getLiveBinding}
        localEditSink={{ recordLocalEdit: () => {} }}
        mouseDownPosRef={{ current: null }}
        onStartEditing={() => {}}
        onFocusSection={() => {}}
        onSetEditorRef={() => {}}
        onEditorReady={() => {}}
        onEditorUnready={() => {}}
        onCursorExit={() => {}}
        onCrossSectionDrop={() => {}}
      />
    </SectionHoverProvider>,
  );
}

describe("DocumentCanvas fragment-key readiness identity (duplicate-render fix)", () => {
  afterEach(() => {
    cleanup();
  });

  it("a ready section keeps isReady (no static underlayer) after a structural index shift", () => {
    // Before the split: [Alpha (focused), Beta]; both editors are ready.
    const before = [makeSection("a", "Alpha"), makeSection("b", "Beta")];
    const ready = new Set<string>(["section::a", "section::b"]);
    const { rerender } = renderCanvas(before, 0, ready);

    // Alpha's editor is mounted and ready → no static "Alpha body" underlayer.
    expect(screen.getByTestId("editor-section::a")).toBeDefined();
    expect(screen.queryByText(/Alpha body/)).toBeNull();

    // A split inserts a new section at the top: Alpha shifts index 0 → 1, Beta
    // 1 → 2. Focus follows Alpha by identity to its new index (state reconcile).
    const after = [makeSection("x", "Inserted"), makeSection("a", "Alpha"), makeSection("b", "Beta")];
    rerender(
      <SectionHoverProvider activeFragmentKey="section::a">
        <DocumentCanvas
          sections={after}
          sectionsLoading={false}
          focusedFragmentKey="section::a"
          proposalMode={false}
          canEditProposalScope={false}
          canEditProposalContent={false}
          proposalScopeMutationInFlight={false}
          selectedProposalSectionKeys={new Set()}
          proposalSectionConflicts={new Map()}
          decodedDocPath="/test/doc.md"
          recentlyChangedByLabel={new Map()}
          injectedByLabel={new Map()}
          dragOverFragmentKey={null}
        isSectionBlocked={() => false}
        publishPaused={false}
          crdtState="connected"
          transferService={null}
          readyEditors={ready}
          getDisplayMarkdown={displayMarkdown}
        getFragmentVersion={() => 0}
          getLiveBinding={getLiveBinding}
          localEditSink={{ recordLocalEdit: () => {} }}
          mouseDownPosRef={{ current: null }}
          onStartEditing={() => {}}
          onFocusSection={() => {}}
          onSetEditorRef={() => {}}
          onEditorReady={() => {}}
          onEditorUnready={() => {}}
          onCursorExit={() => {}}
          onCrossSectionDrop={() => {}}
        />
      </SectionHoverProvider>,
    );

    // Alpha moved to index 1 but its fragment key is still ready → still NO
    // static underlayer. (Index-keyed readiness would resurrect "Alpha body".)
    expect(screen.getByTestId("editor-section::a")).toBeDefined();
    expect(screen.queryByText(/Alpha body/)).toBeNull();
  });
});
