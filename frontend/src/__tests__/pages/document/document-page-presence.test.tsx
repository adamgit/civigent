import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

// --- WsClient mock that captures onEvent handler ---

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

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
    sessionDeparture = vi.fn();
  },
}));

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    focusSection = vi.fn();
  },
}));

vi.mock("../../../services/observer-crdt-provider", () => ({
  ObserverCrdtProvider: class {
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    doc = { on: vi.fn() };
  },
}));

vi.mock("../../../components/MilkdownEditor", () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor">Editor</div>,
}));

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

const sectionsResponse = {
  sections: [
    {
      heading: "",
      heading_path: [] as string[],
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
      content: "# Overview\nOverview.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 1,
      fragment_key: "frag:sec_overview",
      section_file: "sec_overview.md",
    },
  ],
};

function renderDocPage() {
  return render(
    <MemoryRouter initialEntries={["/docs/test.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="test.md" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    const urlStr = String(url);
    if (urlStr.includes("/sections")) {
      return jsonResponse(sectionsResponse);
    }
    if (urlStr.includes("/structure")) {
      return jsonResponse({ structure: [] });
    }
    if (urlStr.includes("/changes-since")) {
      return jsonResponse({ changed_sections: [] });
    }
    return jsonResponse({});
  });
}

describe("DocumentPage presence", () => {
  beforeEach(() => {
    capturedWsHandler = null;
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("presence:editing event shows other user name on affected section", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "presence:editing",
        writer_id: "user-alice",
        writer_display_name: "Alice",
        writer_type: "human",
        doc_path: "test.md",
        heading_path: ["Overview"],
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Alice/)).toBeDefined();
    });
  });

  it("presence:done event removes presence indicator", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    // Show presence
    act(() => {
      capturedWsHandler?.({
        type: "presence:editing",
        writer_id: "user-alice",
        writer_display_name: "Alice",
        writer_type: "human",
        doc_path: "test.md",
        heading_path: ["Overview"],
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Alice/)).toBeDefined();
    });

    // Remove presence
    act(() => {
      capturedWsHandler?.({
        type: "presence:done",
        writer_id: "user-alice",
        writer_display_name: "Alice",
        writer_type: "human",
        doc_path: "test.md",
        heading_path: ["Overview"],
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Alice/)).toBeNull();
    });
  });

  it("agent:reading event shows agent indicator on affected sections", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "agent:reading",
        actor_id: "agent-1",
        actor_display_name: "Agent Bot",
        doc_path: "test.md",
        heading_paths: [["Overview"]],
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Agent Bot/)).toBeDefined();
    });
  });

  it("agent reading indicator expires after 5 seconds", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    // Install fake timers BEFORE the event so the expiry interval is created under fake timers
    vi.useFakeTimers();

    act(() => {
      capturedWsHandler?.({
        type: "agent:reading",
        actor_id: "agent-1",
        actor_display_name: "Agent Bot",
        doc_path: "test.md",
        heading_paths: [["Overview"]],
      } as WsServerEvent);
    });

    // Indicator should be visible immediately
    expect(screen.getByText(/Agent Bot/)).toBeDefined();

    // Advance past expiry (5s + buffer)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(screen.queryByText(/Agent Bot/)).toBeNull();
    vi.useRealTimers();
  });
});
