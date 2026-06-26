import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

/**
 * E5 (todolist): a LIVE split surfaces a new editable section WITHOUT a
 * `content:committed`, AND the survivor's content is preserved (not vanished) —
 * the direct regression for the "edited section vanishes" symptom.
 *
 * The live-topology-adoption fix pushes the new live section list as a
 * `doc:structure-changed` app event. The page adopts it straight from the payload
 * (no REST refetch — a live uncommitted split is invisible to canonical until
 * commit). The survivor's mounted editor keeps its live content by `fragment_key`;
 * the promoted sibling mounts as a new editable section. The Y.Doc binary delta
 * (which carries the new fragment's body) is unordered w.r.t. this event — the
 * section mounts on its fragment_key regardless and the body fills when the delta
 * lands; here the editor is mocked, so we assert surfacing + survivor preservation.
 */

/** Build the rich, SERVER-AUTHORED section shape `doc:structure-changed` carries
 *  (identical to GET …/sections). The real backend builds this from the proposal
 *  layout; the client never synthesizes these fields, so the test payload must be
 *  fully populated too. */
function richStructureSection(heading: string, headingPath: string[], fragmentKey: string, content = "") {
  return {
    heading,
    heading_path: headingPath,
    depth: headingPath.length,
    content,
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: fragmentKey,
    section_file: `${fragmentKey.replace(/^frag:/, "")}.md`,
  };
}

let capturedWsHandler: ((event: WsServerEvent) => void) | null = null;

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    _opts: Record<string, unknown>;
    constructor(_doc: unknown, _docPath: string, opts: Record<string, unknown>) {
      this._opts = opts;
    }
    state = "connected";
    awareness = {
      getLocalState: () => ({ user: {} }),
      setLocalStateField: vi.fn(),
    };
    connect = () => {
      (this._opts?.onStateChange as ((s: string) => void) | undefined)?.("connected");
      (this._opts?.onSynced as (() => void) | undefined)?.();
    };
    disconnect = vi.fn();
    destroy = vi.fn();
    focusSection = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() { return false; }
  },
}));

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: (event: WsServerEvent) => void) => { capturedWsHandler = handler; };
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

// Editor mock renders BOTH its fragment key (to identify which sections mounted)
// and its markdown (to prove the survivor's live content is preserved).
vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { fragmentKey?: string; markdown?: string; onReady?: () => void }, _ref: unknown) => {
        React.useEffect(() => { props.onReady?.(); }, []);
        return (
          <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey}>
            {props.markdown}
          </div>
        );
      },
    ),
  };
});

vi.mock("../../../components/ProposalPanel", () => ({
  ProposalPanel: () => <div data-testid="proposal-panel">ProposalPanel</div>,
}));
vi.mock("../../../services/recent-docs", () => ({ rememberRecentDoc: vi.fn() }));
vi.mock("../../../services/document-visit-history", () => ({
  getLastDocumentVisitAt: () => null,
  markDocumentVisitedNow: vi.fn(),
}));
vi.mock("../../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, resolveWriterId: () => "test-user" };
});

import { DocumentPage } from "../../../pages/DocumentPage";

let sectionsFetchCount = 0;

function renderDocPage() {
  return render(
    <MemoryRouter initialEntries={["/docs/test.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="test.md" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("E5: live split surfaces a new editable section without content:committed", () => {
  beforeEach(() => {
    capturedWsHandler = null;
    sectionsFetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        sectionsFetchCount += 1;
        return jsonResponse({
          sections: [
            {
              heading: "Overview",
              heading_path: ["Overview"],
              depth: 1,
              content: "# Overview\nSurvivor body text.\n",
              humanInvolvement_score: 0,
              crdt_session_active: false,
              section_length_warning: false,
              word_count: 3,
              fragment_key: "frag:sec_overview",
              section_file: "sec_overview.md",
            },
          ],
        });
      }
      if (urlStr.includes("/structure")) return jsonResponse({ structure: [] });
      if (urlStr.includes("/changes-since")) return jsonResponse({ changed_sections: [] });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("mounts the promoted section and preserves the survivor's content", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText(/Survivor body text/)).toBeDefined();
    });

    // The author is editing the survivor → its editor mounts with the live body.
    fireEvent.click(screen.getByText(/Survivor body text/));
    await waitFor(() => {
      const editors = screen.getAllByTestId("milkdown-editor");
      expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_overview")).toBe(true);
    });
    const fetchesBeforeSplit = sectionsFetchCount;

    // A live split lands as a doc:structure-changed event: the survivor (now
    // shrunk on the server) plus a brand-new promoted sibling. No commit, no REST.
    capturedWsHandler?.({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        // The survivor carries its authoritative (now-trimmed) body — the real
        // server builds this from the proposal layout; the client never invents it.
        richStructureSection("Overview", ["Overview"], "frag:sec_overview", "# Overview\nSurvivor body text.\n"),
        richStructureSection("Promoted", ["Promoted"], "frag:sec_promoted"),
      ],
    } as WsServerEvent);

    // The promoted sibling surfaces as a new editable section…
    await waitFor(() => {
      const editors = screen.getAllByTestId("milkdown-editor");
      expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_promoted")).toBe(true);
    });
    // …the survivor's live content is PRESERVED (the vanish-guard) — it neither
    // disappeared nor was blanked by the adoption…
    expect(screen.getByText(/Survivor body text/)).toBeDefined();
    const editors = screen.getAllByTestId("milkdown-editor");
    expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_overview")).toBe(true);
    // …and no canonical refetch occurred — the event payload was the source.
    expect(sectionsFetchCount).toBe(fetchesBeforeSplit);
  });
});
