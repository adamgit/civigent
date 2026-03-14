import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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
      heading_path: [] as string[],
      content: "Root.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 1,
      section_file: "sec_root.md",
    },
    {
      heading_path: ["Overview"],
      content: "Overview.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 1,
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

describe("DocumentPage presence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedWsHandler = null;
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("presence:editing event shows other user name on affected section", async () => {
    await act(async () => {
      renderDocPage();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "presence:editing",
        doc_path: "test.md",
        heading_path: ["Overview"],
        writer_display_name: "Alice",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Alice/)).toBeDefined();
    });
  });

  it("presence:done event removes presence indicator", async () => {
    await act(async () => {
      renderDocPage();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    // Show presence
    act(() => {
      capturedWsHandler?.({
        type: "presence:editing",
        doc_path: "test.md",
        heading_path: ["Overview"],
        writer_display_name: "Alice",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Alice/)).toBeDefined();
    });

    // Remove presence
    act(() => {
      capturedWsHandler?.({
        type: "presence:done",
        doc_path: "test.md",
        heading_path: ["Overview"],
        writer_display_name: "Alice",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Alice/)).toBeNull();
    });
  });

  it("agent:reading event shows agent indicator on affected sections", async () => {
    await act(async () => {
      renderDocPage();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "agent:reading",
        doc_path: "test.md",
        heading_paths: [["Overview"]],
        writer_display_name: "Agent Bot",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Agent Bot/)).toBeDefined();
    });
  });

  it("agent reading indicator expires after 5 seconds", async () => {
    await act(async () => {
      renderDocPage();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    act(() => {
      capturedWsHandler?.({
        type: "agent:reading",
        doc_path: "test.md",
        heading_paths: [["Overview"]],
        writer_display_name: "Agent Bot",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Agent Bot/)).toBeDefined();
    });

    // Advance past expiry (5s + buffer)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Agent Bot/)).toBeNull();
    });
  });
});
