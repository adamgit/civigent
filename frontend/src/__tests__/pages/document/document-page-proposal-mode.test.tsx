import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("sections locked by another human proposal show read-only indicator", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) {
        return jsonResponse({
          sections: [
            {
              heading_path: ["Overview"],
              content: "Overview.\n",
              humanInvolvement_score: 0,
              crdt_session_active: false,
              section_length_warning: false,
              word_count: 1,
              section_file: "sec_overview.md",
              block_reason: "human_proposal",
            },
          ],
        });
      }
      return jsonResponse({});
    });

    renderDocPage();
    await waitFor(() => {
      // The section should show a reserved indicator
      expect(screen.getByText(/Reserved/)).toBeDefined();
    });
  });
});
