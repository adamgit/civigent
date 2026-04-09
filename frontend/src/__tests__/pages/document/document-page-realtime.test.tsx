import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

// --- WsClient mock ---

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

  it("doc:structure-changed event reloads document structure", async () => {
    let structureFetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
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
          ],
        });
      }
      if (urlStr.includes("/structure")) {
        structureFetchCount += 1;
        return jsonResponse({ structure: [] });
      }
      if (urlStr.includes("/changes-since")) {
        return jsonResponse({ changed_sections: [] });
      }
      return jsonResponse({});
    });

    renderDocPage();
    await waitFor(() => {
      expect(structureFetchCount).toBeGreaterThan(0);
    });
    const initialStructureCount = structureFetchCount;

    act(() => {
      capturedWsHandler?.({
        type: "doc:structure-changed",
        doc_path: "test.md",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(structureFetchCount).toBeGreaterThan(initialStructureCount);
    });
  });
});
