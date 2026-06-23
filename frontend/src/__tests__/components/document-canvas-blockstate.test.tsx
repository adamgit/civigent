/**
 * Block-state / publication-pause flow test:
 *   store editability + publishPaused → DocumentCanvas → DocumentSectionRenderer.
 *
 * Asserts the three independent signals from spec 05-ydoc-lifecycle:
 *   - section:blocked → read-only (editor not mounted; click-to-edit gated)
 *   - section:gone    → section unmounted/removed from the canvas
 *   - publication pause → focused editor frozen (read-only)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

// Mock MilkdownEditor so we can observe the readOnly prop the renderer passes.
vi.mock("../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { fragmentKey?: string; readOnly?: boolean; onReady?: () => void }, _ref: unknown) => {
        React.useEffect(() => { props.onReady?.(); }, []);
        return (
          <div
            data-testid={`editor-${props.fragmentKey}`}
            data-readonly={String(!!props.readOnly)}
          >
            editor
          </div>
        );
      },
    ),
  };
});

import { DocumentCanvas } from "../../components/DocumentCanvas";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store";
import { SectionHoverProvider } from "../../contexts/SectionHoverContext";
import type { DocumentSection } from "../../pages/document-page-utils";
import type { CrdtConnectionState } from "../../services/crdt-provider";

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
  focusedSectionIndex: number | null,
  crdtState: CrdtConnectionState = "connected",
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
        store={store}
        transport={null}
        crdtSynced={true}
        crdtState={crdtState}
        transferService={null}
        readyEditors={focusedSectionIndex !== null ? new Set([focusedSectionIndex]) : new Set()}
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

describe("DocumentCanvas block-state / publication-pause flow", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let store: BrowserFragmentReplicaStore;
  let sections: DocumentSection[];

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    store = new BrowserFragmentReplicaStore(doc, awareness);
    sections = [makeSection("a", "Alpha"), makeSection("b", "Beta")];
  });

  afterEach(() => {
    cleanup();
    awareness.destroy();
    doc.destroy();
  });

  it("a blocked, focused section does NOT mount an editor (read-only)", () => {
    store.setSectionBlocked("section::a");
    renderCanvas(store, sections, 0);
    // Blocked section: no editor mounted for it.
    expect(screen.queryByTestId("editor-section::a")).toBeNull();
    // The static prose preview is still rendered.
    expect(screen.getByText(/Alpha body/)).toBeDefined();
  });

  it("a gone section is removed from the canvas entirely", () => {
    store.setSectionGone("section::a");
    renderCanvas(store, sections, null);
    expect(screen.queryByText(/Alpha body/)).toBeNull();
    // The surviving section is still rendered.
    expect(screen.getByText(/Beta body/)).toBeDefined();
  });

  it("publication pause freezes the focused editor (readOnly=true)", () => {
    store.setPublishPaused(true);
    renderCanvas(store, sections, 0);
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
  });

  it("an editable, focused section mounts a writable editor", () => {
    renderCanvas(store, sections, 0);
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("false");
  });

  // ── Connection-degraded rendering (connecting / reconnecting / offline) ──
  // The regression these guard: degraded UI was gated on `reconnecting`/`error`
  // only, so `connecting` (first-connect / hung socket) rendered a normal live,
  // writable editor with no paused affordance. Each non-live phase must force the
  // focused editor read-only AND surface a "editing paused" label.

  it("a focused section while CONNECTING is read-only and shows the paused label", () => {
    renderCanvas(store, sections, 0, "connecting");
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByText(/Connecting — editing paused/)).toBeDefined();
  });

  it("a focused section while RECONNECTING is read-only and shows the paused label", () => {
    renderCanvas(store, sections, 0, "reconnecting");
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByText(/Reconnecting — editing paused/)).toBeDefined();
  });

  it("a focused section while OFFLINE (error) is read-only and shows the paused label", () => {
    renderCanvas(store, sections, 0, "error");
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByText(/Offline — editing paused/)).toBeDefined();
  });

  it("a degraded NEIGHBOR (mounted but not focused) falls back to static prose, not a live editor", () => {
    // focus section a (index 0); section b (index 1) is an eagerly-mounted
    // neighbor. While degraded it must NOT mount a live editor.
    renderCanvas(store, sections, 0, "reconnecting");
    expect(screen.queryByTestId("editor-section::b")).toBeNull();
    expect(screen.getByText(/Beta body/)).toBeDefined();
  });

  it("the focused editor is writable again once the socket is live", () => {
    renderCanvas(store, sections, 0, "connected");
    expect(screen.getByTestId("editor-section::a").getAttribute("data-readonly")).toBe("false");
  });
});
