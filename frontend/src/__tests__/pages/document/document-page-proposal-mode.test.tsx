import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- Mocks ---

const mockProviderConnect = vi.fn();
const mockProviderDisconnect = vi.fn();

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    connect = mockProviderConnect;
    disconnect = mockProviderDisconnect;
    destroy = vi.fn();
    focusSection = vi.fn();
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
  MilkdownEditor: () => <div data-testid="milkdown-editor">Editor</div>,
}));

// ProposalPanel mock that captures callbacks
let capturedEnterProposalMode: ((id: string) => void) | null = null;
let capturedExitProposalMode: (() => void) | null = null;

vi.mock("../../../components/ProposalPanel", () => ({
  ProposalPanel: (props: {
    onEnterProposalMode?: (id: string) => void;
    onExitProposalMode?: () => void;
    proposalMode?: boolean;
  }) => {
    capturedEnterProposalMode = props.onEnterProposalMode ?? null;
    capturedExitProposalMode = props.onExitProposalMode ?? null;
    return (
      <div data-testid="proposal-panel" data-proposal-mode={String(!!props.proposalMode)}>
        ProposalPanel (mode: {props.proposalMode ? "active" : "inactive"})
      </div>
    );
  },
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

describe("DocumentPage proposal mode", () => {
  beforeEach(() => {
    capturedEnterProposalMode = null;
    capturedExitProposalMode = null;
    mockProviderConnect.mockClear();
    mockProviderDisconnect.mockClear();

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
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders ProposalPanel", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByTestId("proposal-panel")).toBeDefined();
    });
  });

  it("ProposalPanel receives proposal mode state", async () => {
    renderDocPage();
    await waitFor(() => {
      const panel = screen.getByTestId("proposal-panel");
      expect(panel.getAttribute("data-proposal-mode")).toBe("false");
    });
  });

});
