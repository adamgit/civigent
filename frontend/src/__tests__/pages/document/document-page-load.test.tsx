import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import { sampleSections } from "../../helpers/sample-data";

// --- Mocks ---

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
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

function renderDocPage(docPath = "ops/strategy.md") {
  return render(
    <MemoryRouter initialEntries={[`/docs/${docPath}`]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride={docPath} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const sectionResponse = {
  sections: sampleSections.map((s, i) => ({
    ...s,
    section_file: i === 0 ? "sec_root.md" : `sec_${s.heading_path[0]?.toLowerCase() || "root"}.md`,
  })),
};

describe("DocumentPage load", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/documents/") && urlStr.includes("/sections")) {
        return jsonResponse(sectionResponse);
      }
      if (urlStr.includes("/api/documents/") && urlStr.includes("/structure")) {
        return jsonResponse({ structure: [{ heading: "Overview", level: 1, children: [] }] });
      }
      if (urlStr.includes("/api/documents/") && urlStr.includes("/changes-since")) {
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

  it("fetches document sections on mount", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.queryByText("Loading document...")).toBeNull();
    });
  });

  it("renders section headings and content", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.queryByText("Loading document...")).toBeNull();
    });
    // The document title should be derived from the path
    expect(screen.getByText("strategy")).toBeDefined();
  });

  it("shows 404 message for non-existent document", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return new Response(JSON.stringify({ message: "Document not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({});
    });

    renderDocPage("nonexistent.md");
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeDefined();
    });
  });

  it("displays doc path in header", async () => {
    renderDocPage("ops/strategy.md");
    await waitFor(() => {
      expect(screen.getAllByText("ops/strategy.md").length).toBeGreaterThan(0);
    });
  });
});
