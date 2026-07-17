/**
 * Block-state / publication-pause flow test:
 *   live-replica editability (`isSectionBlocked`) + `publishPaused` →
 *   DocumentCanvas → DocumentSectionRenderer. There is no legacy store — the
 *   LiveSectionReplica is the only live editability/pause authority.
 *
 * Asserts the three independent signals from spec 05-ydoc-lifecycle:
 *   - blocked → read-only (editor not mounted; click-to-edit gated)
 *   - gone    → the row is absent from the replica topology, so it never renders
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
  live: { blocked?: Set<string>; publishPaused?: boolean },
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
        isSectionBlocked={(fk) => live.blocked?.has(fk) ?? false}
        publishPaused={live.publishPaused ?? false}
        crdtSynced={true}
        crdtState={crdtState}
        transferService={null}
        readyEditors={focusedSectionIndex !== null && sections[focusedSectionIndex]
          ? new Set([sections[focusedSectionIndex].fragment_key])
          : new Set<string>()}
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
  let sections: DocumentSection[];

  beforeEach(() => {
    sections = [makeSection("a", "Alpha"), makeSection("b", "Beta")];
  });

  afterEach(() => {
    cleanup();
  });

  it("a blocked, focused section does NOT mount an editor (read-only)", () => {
    renderCanvas({ blocked: new Set(["section::a"]) }, sections, 0);
    // Blocked section: no editor mounted for it.
    expect(screen.queryByTestId("editor-section::a")).toBeNull();
    // The static prose preview is still rendered.
    expect(screen.getByText(/Alpha body/)).toBeDefined();
  });

  it("a gone section is removed from the canvas entirely (absent from topology rows)", () => {
    // Gone means the fragment dropped out of the replica topology — the page
    // renders rows FROM the topology, so the row simply never reaches the canvas.
    renderCanvas({}, sections.filter((s) => s.fragment_key !== "section::a"), null);
    expect(screen.queryByText(/Alpha body/)).toBeNull();
    // The surviving section is still rendered.
    expect(screen.getByText(/Beta body/)).toBeDefined();
  });

  it("publication pause freezes the focused editor (readOnly=true)", () => {
    renderCanvas({ publishPaused: true }, sections, 0);
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
  });

  it("an editable, focused section mounts a writable editor", () => {
    renderCanvas({}, sections, 0);
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("false");
  });

  // ── Connection-degraded rendering (connecting / reconnecting / offline) ──
  // The regression these guard: degraded UI was gated on `reconnecting`/`error`
  // only, so `connecting` (first-connect / hung socket) rendered a normal live,
  // writable editor with no paused affordance. Each non-live phase must force the
  // focused editor read-only AND surface a "editing paused" label.

  it("a focused section while CONNECTING is read-only and shows the paused label", () => {
    renderCanvas({}, sections, 0, "connecting");
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByText(/Connecting — editing paused/)).toBeDefined();
  });

  it("a focused section while RECONNECTING is read-only and shows the paused label", () => {
    renderCanvas({}, sections, 0, "reconnecting");
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByText(/Reconnecting — editing paused/)).toBeDefined();
  });

  it("a focused section while OFFLINE (error) is read-only and shows the paused label", () => {
    renderCanvas({}, sections, 0, "error");
    const editor = screen.getByTestId("editor-section::a");
    expect(editor.getAttribute("data-readonly")).toBe("true");
    expect(screen.getByText(/Offline — editing paused/)).toBeDefined();
  });

  it("a degraded NEIGHBOR (mounted but not focused) falls back to static prose, not a live editor", () => {
    // focus section a (index 0); section b (index 1) is an eagerly-mounted
    // neighbor. While degraded it must NOT mount a live editor.
    renderCanvas({}, sections, 0, "reconnecting");
    expect(screen.queryByTestId("editor-section::b")).toBeNull();
    expect(screen.getByText(/Beta body/)).toBeDefined();
  });

  it("the focused editor is writable again once the socket is live", () => {
    renderCanvas({}, sections, 0, "connected");
    expect(screen.getByTestId("editor-section::a").getAttribute("data-readonly")).toBe("false");
  });
});
