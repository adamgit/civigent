/**
 * DocumentPage open/edit workflow coverage (spec 05 §Session Lifecycle; spec 06
 * §Refresh Strategy).
 *
 * These exercise the component/hook composition boundary that the narrow
 * helper/hook tests missed:
 *   1. Click-to-edit must leave the editor mounted after the initial load settles —
 *      the observer guard must not tear down the active editor transport.
 *   2. A structural split that lands while an editor is mounted must become visible
 *      WITHOUT a page refresh: the promoted child section renders and the mounted
 *      survivor editor is preserved.
 *
 * Mocked at the API/WS/transport boundary; no browser automation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

const mockProviderDestroy = vi.fn();
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
    destroy = mockProviderDestroy;
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

const survivorSection = {
  heading: "Overview",
  heading_path: ["Overview"],
  depth: 1,
  content: "# Overview\nOverview content.\n",
  humanInvolvement_score: 0,
  crdt_session_active: false,
  section_length_warning: false,
  word_count: 2,
  fragment_key: "frag:sec_overview",
  section_file: "sec_overview.md",
};

const promotedChildSection = {
  heading: "Sub",
  heading_path: ["Overview", "Sub"],
  depth: 2,
  content: "# Sub\nPROMOTED CHILD BODY.\n",
  humanInvolvement_score: 0,
  crdt_session_active: false,
  section_length_warning: false,
  word_count: 2,
  fragment_key: "frag:sec_sub",
  section_file: "sec_sub.md",
};

let sectionsCallCount = 0;

function renderDocPage() {
  return render(
    <MemoryRouter initialEntries={["/docs/test.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="test.md" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocumentPage open/edit workflows", () => {
  beforeEach(() => {
    mockProviderDestroy.mockClear();
    capturedWsHandler = null;
    sectionsCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        sectionsCallCount += 1;
        // First load: just the survivor. After commit: survivor + promoted child.
        return jsonResponse({
          sections: sectionsCallCount === 1 ? [survivorSection] : [survivorSection, promotedChildSection],
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

  it("renders a promoted split section without a refresh while the survivor editor stays mounted", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview content.")).toBeDefined();
    });

    // Enter edit on the survivor → its editor mounts (CRDT session active).
    fireEvent.click(screen.getByText("Overview content."));
    await waitFor(() => {
      const editors = screen.getAllByTestId("milkdown-editor");
      expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_overview")).toBe(true);
    });

    // A quiescence split lands: server reports survivor + promoted child.
    capturedWsHandler?.({
      type: "content:committed",
      doc_path: "test.md",
      writer_display_name: "Collaborator",
      writer_type: "human",
      sections: [{ doc_path: "test.md", heading_path: ["Overview", "Sub"] }],
      commit_sha: "deadbeef",
    } as WsServerEvent);

    // The promoted child becomes visible WITHOUT a page refresh.
    await waitFor(() => {
      expect(screen.getByText("PROMOTED CHILD BODY.")).toBeDefined();
    });
    // The survivor's mounted editor is preserved (not torn down by the refresh).
    const editors = screen.getAllByTestId("milkdown-editor");
    expect(editors.some((e) => e.getAttribute("data-fragment-key") === "frag:sec_overview")).toBe(true);
  });
});
