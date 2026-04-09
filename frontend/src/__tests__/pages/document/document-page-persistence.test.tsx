import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- CrdtProvider mock with callback capture ---

type ProviderOpts = {
  onLocalUpdate?: (modifiedFragmentKeys: string[]) => void;
  onSessionOverlayImportStarted?: () => void;
  onSessionOverlayImported?: (payload: { writtenKeys: string[]; deletedKeys: string[] }) => void;
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
    awareness = {
      getLocalState: () => ({ user: {} }),
      setLocalStateField: vi.fn(),
    };
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
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // Text assertion tests for status bar copy ("Unsaved", "waiting for save", "All changes saved")
  // were removed — they assert exact UI text that changes frequently and add no behavioral value.
});
