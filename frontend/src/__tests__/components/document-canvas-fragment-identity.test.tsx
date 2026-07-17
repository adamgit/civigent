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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

// Mock MilkdownEditor so a mounted editor is observable and never renders the
// section body itself (so any "<heading> body" text comes from the underlayer).
vi.mock("../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { fragmentKey?: string }, _ref: unknown) => (
        <div data-testid={`editor-${props.fragmentKey}`}>editor</div>
      ),
    ),
  };
});

import { DocumentCanvas } from "../../components/DocumentCanvas";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store";
import { SectionHoverProvider } from "../../contexts/SectionHoverContext";
import type { DocumentSection } from "../../pages/document-page-utils";

function makeSection(file: string, heading: string): DocumentSection {
  return {
    heading,
    heading_path: [heading],
    depth: 1,
    content: `${heading} body`,
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 2,
    fragment_key: `section::${file}`,
    section_file: `${file}.md`,
  } as DocumentSection;
}

function renderCanvas(
  store: BrowserFragmentReplicaStore,
  sections: DocumentSection[],
  focusedSectionIndex: number,
  readyEditors: Set<string>,
) {
  return render(
    <SectionHoverProvider activeSectionIndex={focusedSectionIndex}>
      <DocumentCanvas
        sections={sections}
        sectionsLoading={false}
        focusedSectionIndex={focusedSectionIndex}
        proposalMode={false}
        canEditProposalScope={false}
        canEditProposalContent={false}
        proposalScopeMutationInFlight={false}
        selectedProposalSectionKeys={new Set()}
        proposalSectionConflicts={new Map()}
        decodedDocPath="/test/doc.md"
        recentlyChangedByLabel={new Map()}
        injectedByLabel={new Map()}
        dragOverSectionIndex={null}
        isSectionBlocked={() => false}
        publishPaused={false}
        crdtSynced={true}
        crdtState="connected"
        transferService={null}
        readyEditors={readyEditors}
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
  let doc: Y.Doc;
  let awareness: Awareness;
  let store: BrowserFragmentReplicaStore;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    store = new BrowserFragmentReplicaStore(doc, awareness);
  });

  afterEach(() => {
    cleanup();
    awareness.destroy();
    doc.destroy();
  });

  it("a ready section keeps isReady (no static underlayer) after a structural index shift", () => {
    // Before the split: [Alpha (focused), Beta]; both editors are ready.
    const before = [makeSection("a", "Alpha"), makeSection("b", "Beta")];
    const ready = new Set<string>(["section::a", "section::b"]);
    const { rerender } = renderCanvas(store, before, 0, ready);

    // Alpha's editor is mounted and ready → no static "Alpha body" underlayer.
    expect(screen.getByTestId("editor-section::a")).toBeDefined();
    expect(screen.queryByText(/Alpha body/)).toBeNull();

    // A split inserts a new section at the top: Alpha shifts index 0 → 1, Beta
    // 1 → 2. Focus follows Alpha by identity to its new index (state reconcile).
    const after = [makeSection("x", "Inserted"), makeSection("a", "Alpha"), makeSection("b", "Beta")];
    rerender(
      <SectionHoverProvider activeSectionIndex={1}>
        <DocumentCanvas
          sections={after}
          sectionsLoading={false}
          focusedSectionIndex={1}
          proposalMode={false}
          canEditProposalScope={false}
          canEditProposalContent={false}
          proposalScopeMutationInFlight={false}
          selectedProposalSectionKeys={new Set()}
          proposalSectionConflicts={new Map()}
          decodedDocPath="/test/doc.md"
          recentlyChangedByLabel={new Map()}
          injectedByLabel={new Map()}
          dragOverSectionIndex={null}
        isSectionBlocked={() => false}
        publishPaused={false}
          crdtSynced={true}
          crdtState="connected"
          transferService={null}
          readyEditors={ready}
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
