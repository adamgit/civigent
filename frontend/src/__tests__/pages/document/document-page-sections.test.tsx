import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

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

const multiSectionResponse = {
  sections: [
    {
      heading: "",
      heading_path: [] as string[],
      depth: 0,
      content: "Preamble content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 2,
      fragment_key: "frag:sec_root",
      section_file: "sec_root.md",
    },
    {
      heading: "Overview",
      heading_path: ["Overview"],
      depth: 1,
      content: "# Overview\nThe overview section.\n",
      humanInvolvement_score: 0.2,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 3,
      fragment_key: "frag:sec_overview",
      section_file: "sec_overview.md",
    },
    {
      heading: "Details",
      heading_path: ["Details"],
      depth: 1,
      content: "# Details\nThe details.\n",
      humanInvolvement_score: 0.6,
      crdt_session_active: true,
      section_length_warning: false,
      word_count: 2,
      fragment_key: "frag:sec_details",
      section_file: "sec_details.md",
    },
  ],
};

function renderDocPage(docPath = "ops/strategy.md") {
  return render(
    <MemoryRouter initialEntries={[`/docs/${docPath}`]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride={docPath} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocumentPage sections", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return jsonResponse(multiSectionResponse);
      }
      if (urlStr.includes("/structure")) {
        return jsonResponse({
          structure: [
            { heading: "Overview", level: 1, children: [] },
            { heading: "Details", level: 1, children: [] },
          ],
        });
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

  it("renders all sections", async () => {
    renderDocPage();
    await waitFor(() => {
      // The section headings should be visible as rendered markdown
      expect(screen.getByText("Overview")).toBeDefined();
      expect(screen.getByText("Details")).toBeDefined();
    });
  });

  it("renders section content as markdown", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Preamble content.")).toBeDefined();
      expect(screen.getByText("The overview section.")).toBeDefined();
    });
  });

  it("shows empty document message when no sections", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return jsonResponse({ sections: [] });
      }
      return jsonResponse({});
    });

    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Document is empty.")).toBeDefined();
    });
  });
});
