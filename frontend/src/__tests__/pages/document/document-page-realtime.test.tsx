import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

// --- WsClient mock ---

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

/** Build the rich, SERVER-AUTHORED section shape `doc:structure-changed` carries
 *  (identical to GET …/sections). The client never synthesizes these fields, so the
 *  test payload must be fully populated too. */
function richStructureSection(heading: string, headingPath: string[], fragmentKey: string) {
  return {
    heading,
    heading_path: headingPath,
    depth: headingPath.length,
    content: "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: fragmentKey,
    section_file: `${fragmentKey.replace(/^frag:/, "")}.md`,
  };
}

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: WsEventHandler) => {
      capturedWsHandler = handler;
    };
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

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

vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { fragmentKey?: string; onReady?: () => void }, _ref: unknown) => {
        React.useEffect(() => { props.onReady?.(); }, []);
        return (
          <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey}>
            Editor:{props.fragmentKey}
          </div>
        );
      },
    ),
  };
});

vi.mock("../../../components/ProposalPanel", () => ({
  ProposalPanel: () => <div data-testid="proposal-panel">ProposalPanel</div>,
}));

vi.mock("../../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

vi.mock("../../../services/document-visit-history", () => ({
  getLastDocumentVisitAt: () => null,
  markDocumentVisitedNow: vi.fn(),
}));

vi.mock("../../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    resolveWriterId: () => "test-user",
  };
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

describe("DocumentPage realtime", () => {
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
              heading: "",
              heading_path: [],
              depth: 0,
              content: "Root.\n",
              humanInvolvement_score: 0,
              crdt_session_active: false,
              section_length_warning: false,
              word_count: 1,
              fragment_key: "frag:sec_root",
              section_file: "sec_root.md",
            },
            {
              heading: "Overview",
              heading_path: ["Overview"],
              depth: 1,
              content: `# Overview\nOverview v${sectionsFetchCount}.\n`,
              humanInvolvement_score: 0,
              crdt_session_active: false,
              section_length_warning: false,
              word_count: 2,
              fragment_key: "frag:sec_overview",
              section_file: "sec_overview.md",
            },
          ],
        });
      }
      if (urlStr.includes("/structure")) {
        return jsonResponse({ structure: [{ heading: "Overview", level: 1, children: [] }] });
      }
      if (urlStr.includes("/changes-since")) {
        return jsonResponse({ changed_sections: [] });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("content:committed from another writer reloads sections", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText(/Overview v1/)).toBeDefined();
    });
    const initialCount = sectionsFetchCount;

    // Emit content:committed event
    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "test.md",
        writer_display_name: "Agent",
        writer_type: "agent",
        sections: [{ doc_path: "test.md", heading_path: ["Overview"] }],
        commit_sha: "abc123",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(sectionsFetchCount).toBeGreaterThan(initialCount);
    });
  });

  // Todolist item 28/60 (the live-topology-adoption fix): a LIVE split is pushed
  // to the client as a `doc:structure-changed` app event carrying the authoritative
  // live section list. The page adopts it straight from the payload — NO REST
  // refetch (a live uncommitted split is invisible to canonical until commit) — so
  // the newly-promoted editable section surfaces BEFORE any `content:committed`,
  // while the survivor's mounted editor is preserved.
  it("a LIVE doc:structure-changed split surfaces the new editable section before content:committed", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText(/Overview v1/)).toBeDefined();
    });
    const fetchesBeforeSplit = sectionsFetchCount;

    // Focus the survivor (Overview) so its editor mounts — this is the section a
    // user is typing into when the split happens.
    fireEvent.click(screen.getByText(/Overview v1/));
    await waitFor(() => {
      const editors = screen.getAllByTestId("milkdown-editor");
      expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_overview")).toBe(true);
    });

    // A live split lands: the server pushes the new live section list (survivor +
    // a brand-new same-level sibling) as a doc:structure-changed event. No commit.
    capturedWsHandler?.({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        richStructureSection("", [], "frag:sec_root"),
        richStructureSection("Overview", ["Overview"], "frag:sec_overview"),
        richStructureSection("Second Section", ["Second Section"], "frag:sec_second"),
      ],
    } as WsServerEvent);

    // The promoted sibling surfaces as an editable section (adjacent to the focused
    // survivor → its editor mounts) WITHOUT any content:committed or REST refetch.
    await waitFor(() => {
      const editors = screen.getAllByTestId("milkdown-editor");
      expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_second")).toBe(true);
    });
    // No canonical refetch happened — the event payload was the source of truth.
    expect(sectionsFetchCount).toBe(fetchesBeforeSplit);
    // The survivor's editor is preserved (not torn down / remounted by adoption).
    const editors = screen.getAllByTestId("milkdown-editor");
    expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_overview")).toBe(true);
  });
});
