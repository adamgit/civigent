/**
 * Lazy editor mounting (spec 05 §Y.Doc Lifecycle; editor virtualization).
 *
 * Only the focused section plus its immediate previous/next sections mount a
 * Milkdown editor; far sections do not. Focusing a different section mounts that
 * section's window ON DEMAND (so a previously-unmounted section gains an editor).
 *
 * ArrowUp/ArrowDown navigation lives in the section navigator component and is
 * NOT duplicated here — this only pins the mount window by fragment key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    _opts: Record<string, unknown>;
    constructor(_doc: unknown, _docPath: string, opts: Record<string, unknown>) {
      this._opts = opts;
    }
    state = "connected";
    awareness = { getLocalState: () => ({ user: {} }), setLocalStateField: vi.fn() };
    connect = () => {
      (this._opts?.onStateChange as ((s: string) => void) | undefined)?.("connected");
      (this._opts?.onSynced as (() => void) | undefined)?.();
    };
    disconnect = vi.fn();
    destroy = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() { return false; }
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
  },
}));

vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { fragmentKey?: string; onReady?: () => void }, _ref: unknown) => {
        React.useEffect(() => { props.onReady?.(); }, []);
        return <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey} />;
      },
    ),
  };
});

vi.mock("../../../components/ProposalPanel", () => ({
  ProposalPanel: () => <div data-testid="proposal-panel" />,
}));
vi.mock("../../../services/recent-docs", () => ({ rememberRecentDoc: vi.fn() }));
vi.mock("../../../services/document-visit-history", () => ({
  getLastDocumentVisitAt: () => null,
  markDocumentVisitedNow: vi.fn(),
}));
vi.mock("../../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, resolveWriterId: () => "test-user" };
});

import { DocumentPage } from "../../../pages/DocumentPage";

const SECTIONS = [
  { heading: "", heading_path: [] as string[], content: "Root body.\n", fragment_key: "frag:sec_root", section_file: "sec_root.md" },
  { heading: "Overview", heading_path: ["Overview"], content: "# Overview\nOverview body.\n", fragment_key: "frag:sec_overview", section_file: "sec_overview.md" },
  { heading: "Details", heading_path: ["Details"], content: "# Details\nDetails body.\n", fragment_key: "frag:sec_details", section_file: "sec_details.md" },
  { heading: "Appendix", heading_path: ["Appendix"], content: "# Appendix\nAppendix body.\n", fragment_key: "frag:sec_appendix", section_file: "sec_appendix.md" },
].map((s) => ({
  ...s,
  depth: s.heading_path.length,
  humanInvolvement_score: 0,
  crdt_session_active: false,
  section_length_warning: false,
  word_count: 2,
}));

function mountedFragmentKeys(): string[] {
  return screen
    .queryAllByTestId("milkdown-editor")
    .map((el) => el.getAttribute("data-fragment-key") ?? "");
}

function renderDocPage() {
  return render(
    <MemoryRouter initialEntries={["/docs/test.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="test.md" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocumentPage lazy editor mounting (spec 05)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) return jsonResponse({ sections: SECTIONS });
      if (urlStr.includes("/structure")) return jsonResponse({ structure: [] });
      if (urlStr.includes("/changes-since")) return jsonResponse({ changed_sections: [] });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("mounts only the focused section plus immediate neighbors, expanding on demand", async () => {
    renderDocPage();
    await waitFor(() => expect(screen.getByText("Overview body.")).toBeDefined());

    // Focus Overview (index 1): window = root(0), Overview(1), Details(2).
    fireEvent.click(screen.getByText("Overview body."));
    await waitFor(() => expect(mountedFragmentKeys()).toContain("frag:sec_overview"));

    const afterOverview = new Set(mountedFragmentKeys());
    expect(afterOverview.has("frag:sec_root")).toBe(true);
    expect(afterOverview.has("frag:sec_overview")).toBe(true);
    expect(afterOverview.has("frag:sec_details")).toBe(true);
    // The far section is NOT mounted yet.
    expect(afterOverview.has("frag:sec_appendix")).toBe(false);

    // Focus Appendix (index 3): its window mounts ON DEMAND (Details + Appendix).
    fireEvent.click(screen.getByText("Appendix body."));
    await waitFor(() => expect(mountedFragmentKeys()).toContain("frag:sec_appendix"));
    expect(new Set(mountedFragmentKeys()).has("frag:sec_details")).toBe(true);
  });
});
