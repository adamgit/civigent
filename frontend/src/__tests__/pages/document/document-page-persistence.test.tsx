import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- CrdtProvider mock with callback capture ---

type ProviderOpts = {
  onLocalUpdate?: () => void;
  onFlushStarted?: () => void;
  onSessionFlushed?: (payload: { writtenKeys: string[]; deletedKeys: string[] }) => void;
  onStateChange?: (state: string) => void;
  onSynced?: () => void;
  onError?: (reason: string) => void;
  onIdleTimeout?: () => void;
};

let capturedOpts: ProviderOpts | null = null;

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    constructor(_doc: unknown, _docPath: string, opts: ProviderOpts) {
      capturedOpts = opts;
    }
    connect = vi.fn();
    disconnect = vi.fn();
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

describe("DocumentPage persistence", () => {
  beforeEach(() => {
    capturedOpts = null;
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

  it("local Y.Doc update marks focused section as dirty", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    // Enter edit mode
    fireEvent.click(screen.getByText("Overview."));
    await waitFor(() => {
      expect(capturedOpts).not.toBeNull();
    });

    // Simulate local update callback
    capturedOpts!.onLocalUpdate?.();

    await waitFor(() => {
      expect(screen.getByText("Unsaved")).toBeDefined();
    });
  });

  it("SESSION_FLUSH_STARTED transitions dirty to pending", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Overview."));
    await waitFor(() => {
      expect(capturedOpts).not.toBeNull();
    });

    // Mark dirty
    capturedOpts!.onLocalUpdate?.();
    await waitFor(() => {
      expect(screen.getByText("Unsaved")).toBeDefined();
    });

    // Flush started
    capturedOpts!.onFlushStarted?.();
    await waitFor(() => {
      expect(screen.getByText(/waiting for save/)).toBeDefined();
    });
  });

  it("SESSION_FLUSHED transitions to flushed state", async () => {
    renderDocPage();
    await waitFor(() => {
      expect(screen.getByText("Overview.")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Overview."));
    await waitFor(() => {
      expect(capturedOpts).not.toBeNull();
    });

    // Mark dirty then flush
    capturedOpts!.onLocalUpdate?.();
    capturedOpts!.onFlushStarted?.();
    capturedOpts!.onSessionFlushed?.({
      writtenKeys: ["section::sec_overview"],
      deletedKeys: [],
    });

    await waitFor(() => {
      expect(screen.getByText("All changes saved")).toBeDefined();
    });
  });
});
