import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- CrdtProvider mock that tracks calls ---

const mockProviderConnect = vi.fn();
const mockProviderDestroy = vi.fn();
const mockSetPublishPauseBarrier = vi.fn();

const BEFORE_FIRST_HEADING_KEY = "section::__beforeFirstHeading__";

const editorProviderOpts: Record<string, unknown>[] = [];

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    _opts: Record<string, unknown>;
    constructor(_doc: unknown, _docPath: string, opts: Record<string, unknown>) {
      this._opts = opts;
      editorProviderOpts.push(opts);
    }
    state = "connected";
    awareness = {
      getLocalState: () => ({ user: {} }),
      setLocalStateField: vi.fn(),
    };
    connect = () => {
      mockProviderConnect();
      (this._opts?.onStateChange as ((s: string) => void) | undefined)?.("connected");
      (this._opts?.onBootstrapApplied as (() => void) | undefined)?.();
    };
    disconnect = vi.fn();
    destroy = mockProviderDestroy;
    setPublishPauseBarrier = mockSetPublishPauseBarrier;
    get isPublishPaused() { return false; }
  },
}));

// Observer mock capturing events so tests can deliver the live-sections
// bootstrap (mount gate: live editors require a binding, which requires the
// replica to be currently live authority).
const observerEvents: Record<string, unknown>[] = [];
vi.mock("../../../services/observer-crdt-provider", () => ({
  ObserverCrdtProvider: class {
    events: Record<string, unknown>;
    destroy = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(_docPath: string, events: Record<string, unknown>, _opts?: Record<string, unknown>) {
      this.events = events;
      observerEvents.push(events);
    }
  },
}));

vi.mock("../../../services/ws-client", () => ({
  getAppWsTransportInfo: (() => {
    const snapshot = { kind: null, fallbackReason: null };
    return () => snapshot;
  })(),
  subscribeAppWsTransport: () => () => {},
  describeAppWsBroadcastFallback: () => "",
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  const { unwrapLiveEditorBindingForMilkdown } = await import("../../../services/live-section-replica");
  return {
    MilkdownEditor: React.forwardRef(
      (props: {
        binding?: import("../../../services/live-section-replica").LiveEditorBinding;
        onReady?: () => void;
      }, _ref: unknown) => {
        React.useEffect(() => { props.onReady?.(); }, []);
        const fk = props.binding ? unwrapLiveEditorBindingForMilkdown(props.binding).fragmentKey : undefined;
        return (
          <div data-testid="milkdown-editor" data-fragment-key={fk}>
            Editor:{fk}
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
import { act } from "@testing-library/react";
import { liveBootstrapFrame, MSG_LIVE_SECTIONS_BOOTSTRAP_OPCODE } from "../../helpers/live-bootstrap";

const sectionsResponse = {
  sections: [
    {
      heading: "",
      heading_path: [] as string[],
      depth: 0,
      content: "Root content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      fragment_key: "frag:sec_root",
      section_file: "/sec_root.md",
    },
    {
      heading: "Overview",
      heading_path: ["Overview"],
      depth: 1,
      content: "# Overview\nOverview content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      fragment_key: "frag:sec_overview",
      section_file: "/sec_overview.md",
    },
    {
      heading: "Details",
      heading_path: ["Details"],
      depth: 1,
      content: "# Details\nDetails content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      fragment_key: "frag:sec_details",
      section_file: "/sec_details.md",
    },
  ],
};

const LIVE_FIXTURE_SECTIONS = [
  { fragmentKey: "frag:sec_root", headingPath: [] as string[], markdown: "Root content.\n" },
  { fragmentKey: "frag:sec_overview", headingPath: ["Overview"], markdown: "# Overview\nOverview content.\n" },
  { fragmentKey: "frag:sec_details", headingPath: ["Details"], markdown: "# Details\nDetails content.\n" },
];

/** Deliver the live bootstrap on the latest observer socket (pre-click path). */
async function deliverObserverBootstrap(): Promise<void> {
  await waitFor(() => expect(observerEvents.length).toBeGreaterThan(0));
  const events = observerEvents[observerEvents.length - 1];
  await act(async () => {
    (events.onLiveSectionFrame as ((op: number, p: Uint8Array) => void) | undefined)?.(
      MSG_LIVE_SECTIONS_BOOTSTRAP_OPCODE,
      liveBootstrapFrame("SESS-1", LIVE_FIXTURE_SECTIONS),
    );
  });
}

/** Deliver a live bootstrap on the latest editor socket (empty-doc first-edit path). */
async function deliverEditorBootstrap(sections: { fragmentKey: string; headingPath: string[]; markdown: string }[]): Promise<void> {
  await waitFor(() => expect(editorProviderOpts.length).toBeGreaterThan(0));
  const opts = editorProviderOpts[editorProviderOpts.length - 1];
  await act(async () => {
    (opts.onLiveSectionFrame as ((op: number, p: Uint8Array) => void) | undefined)?.(
      MSG_LIVE_SECTIONS_BOOTSTRAP_OPCODE,
      liveBootstrapFrame("SESS-1", sections),
    );
  });
}

function renderDocPage() {
  return render(
    <MemoryRouter initialEntries={["/docs/test.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="/test.md" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocumentPage editing", () => {
  beforeEach(() => {
    mockProviderConnect.mockClear();
    mockProviderDestroy.mockClear();
    mockSetPublishPauseBarrier.mockClear();
    editorProviderOpts.length = 0;
    observerEvents.length = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return jsonResponse(sectionsResponse);
      }
      if (urlStr.includes("/structure")) {
        return jsonResponse({ structure: [] });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("clicking a section enters edit mode", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview content.")).toBeDefined();
    });

    await deliverObserverBootstrap();
    // Click the Overview section to start editing
    fireEvent.click(screen.getByText("Overview content."));

    await waitFor(() => {
      // MilkdownEditor should be mounted
      const editors = screen.getAllByTestId("milkdown-editor");
      expect(editors.length).toBeGreaterThan(0);
    });
  });

  it("edit mode creates CrdtProvider", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview content.")).toBeDefined();
    });

    await deliverObserverBootstrap();
    fireEvent.click(screen.getByText("Overview content."));

    await waitFor(() => {
      expect(mockProviderConnect).toHaveBeenCalled();
    });
  });

  it("only focused section and neighbors have mounted editors", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview content.")).toBeDefined();
    });

    await deliverObserverBootstrap();
    // Click the middle section (index 1 = Overview)
    fireEvent.click(screen.getByText("Overview content."));

    await waitFor(() => {
      const editors = screen.getAllByTestId("milkdown-editor");
      // Should mount editors for focused section and its neighbors
      // Focused is index 1, neighbors are 0 and 2 = 3 editors max
      expect(editors.length).toBeLessThanOrEqual(3);
      expect(editors.length).toBeGreaterThan(0);
    });
  });

  it("clicking an empty document enters edit mode", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return jsonResponse({ sections: [] });
      }
      if (urlStr.includes("/structure")) {
        return jsonResponse({ structure: [] });
      }
      return jsonResponse({});
    });

    renderDocPage();

    const emptyState = await screen.findByText("Document is empty.");
    fireEvent.click(emptyState);

    await waitFor(() => {
      expect(mockProviderConnect).toHaveBeenCalled();
    });
    // The server's DocSession bootstrap (with the synthetic BFH fragment)
    // arrives on the editor socket; only then may the live editor mount.
    await deliverEditorBootstrap([
      { fragmentKey: BEFORE_FIRST_HEADING_KEY, headingPath: [], markdown: "" },
    ]);
    await waitFor(() => {
      expect(screen.getByTestId("milkdown-editor")).toBeDefined();
    });
  });

  it("a newly created (empty) document mounts the synthetic BFH editor on edit", async () => {
    // The legacy server-routed `sendSectionMutate` first-write RPC is removed
    // (spec 05 §4 > Removed message types). The first edit now flows as an
    // ordinary local Y.Doc write through the mounted editor. Here we assert the
    // synthetic before-first-heading editor mounts when entering edit mode.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return jsonResponse({ sections: [] });
      }
      if (urlStr.includes("/structure")) {
        return jsonResponse({ structure: [] });
      }
      return jsonResponse({});
    });

    renderDocPage();

    fireEvent.click(await screen.findByText("Document is empty."));

    await deliverEditorBootstrap([
      { fragmentKey: BEFORE_FIRST_HEADING_KEY, headingPath: [], markdown: "" },
    ]);
    await waitFor(() => {
      const editor = screen.getByTestId("milkdown-editor");
      expect(editor.getAttribute("data-fragment-key")).toBe(BEFORE_FIRST_HEADING_KEY);
    });
  });
});
