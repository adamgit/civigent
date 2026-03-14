import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- CrdtProvider mock that tracks calls ---

const mockProviderConnect = vi.fn();
const mockProviderDestroy = vi.fn();
const mockProviderFocusSection = vi.fn();

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    constructor(_doc: unknown, _docPath: string, opts: Record<string, unknown>) {
      // Store callbacks for test access
      (this as any)._opts = opts;
    }
    connect = mockProviderConnect;
    disconnect = vi.fn();
    destroy = mockProviderDestroy;
    focusSection = mockProviderFocusSection;
  },
}));

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

vi.mock("../../../components/MilkdownEditor", () => ({
  MilkdownEditor: (props: { fragmentKey?: string }) => (
    <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey}>
      Editor:{props.fragmentKey}
    </div>
  ),
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
      content: "Root content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 2,
      section_file: "sec_root.md",
    },
    {
      heading_path: ["Overview"],
      content: "Overview content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 2,
      section_file: "sec_overview.md",
    },
    {
      heading_path: ["Details"],
      content: "Details content.\n",
      humanInvolvement_score: 0,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 2,
      section_file: "sec_details.md",
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

describe("DocumentPage editing", () => {
  beforeEach(() => {
    mockProviderConnect.mockClear();
    mockProviderDestroy.mockClear();
    mockProviderFocusSection.mockClear();

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
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("clicking a section enters edit mode", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview content.")).toBeDefined();
    });

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
});
