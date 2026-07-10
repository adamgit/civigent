import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

/**
 * E6 (todolist): cross-client silent-vanish guard. Another writer's split arrives
 * as a live `doc:structure-changed` event at a client that is NOT itself editing
 * the split section (a passive peer). The guard: the current client must NOT lose
 * content with no replacement — the survivor keeps its body AND the promoted
 * section appears. Never a section that vanishes with nothing in its place.
 *
 * The fix delivers the new live section list to EVERY subscribed socket (the
 * server emits `doc:structure-changed` after broadcasting the Y.Doc delta), so a
 * peer's split reaches this client through the same event — origin-agnostic. Here
 * the peer is passive (no editor mounted), so sections render as static previews;
 * we assert the survivor's preview content survives and a new section preview is
 * added (no REST refetch — the payload is the source).
 */

/** Build the rich, SERVER-AUTHORED section shape `doc:structure-changed` carries
 *  (identical to GET …/sections). The client never synthesizes these fields, so the
 *  test payload must be fully populated too. */
function richStructureSection(heading: string, headingPath: string[], fragmentKey: string, content = "") {
  return {
    heading,
    heading_path: headingPath,
    depth: headingPath.length,
    content,
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: fragmentKey,
    section_file: `${fragmentKey.replace(/^frag:/, "")}.md`,
  };
}

let capturedWsHandler: ((event: WsServerEvent) => void) | null = null;

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    _opts: Record<string, unknown>;
    constructor(_doc: unknown, _docPath: string, opts: Record<string, unknown>) {
      this._opts = opts;
    }
    state = "connected";
    awareness = {
      getLocalState: () => ({ user: {} }),
      setLocalStateField: vi.fn(),
    };
    connect = () => {
      (this._opts?.onStateChange as ((s: string) => void) | undefined)?.("connected");
      (this._opts?.onSynced as (() => void) | undefined)?.();
    };
    disconnect = vi.fn();
    destroy = vi.fn();
    focusSection = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() { return false; }
  },
}));

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: (event: WsServerEvent) => void) => { capturedWsHandler = handler; };
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
      (props: { fragmentKey?: string; markdown?: string; onReady?: () => void }, _ref: unknown) => {
        React.useEffect(() => { props.onReady?.(); }, []);
        return (
          <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey}>
            {props.markdown}
          </div>
        );
      },
    ),
  };
});

vi.mock("../../../components/ProposalPanel", () => ({
  ProposalPanel: () => <div data-testid="proposal-panel">ProposalPanel</div>,
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

describe("E6: cross-client split must not silently vanish the current client's content", () => {
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
              heading: "Overview",
              heading_path: ["Overview"],
              depth: 1,
              content: "# Overview\nPeer-visible body.\n",
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
      if (urlStr.includes("/structure")) return jsonResponse({ structure: [] });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("retains content and surfaces the replacement section on an inbound split", async () => {
    const { container } = renderDocPage();
    // Passive peer: not editing — the section renders as a static preview.
    await waitFor(() => {
      expect(screen.getByText(/Peer-visible body/)).toBeDefined();
    });
    const previewsBefore = container.querySelectorAll(".doc-prose").length;
    expect(previewsBefore).toBe(1);
    const fetchesBeforeSplit = sectionsFetchCount;

    // Another writer's split arrives as a doc:structure-changed event: the survivor
    // plus a brand-new promoted sibling. This client did not cause it.
    capturedWsHandler?.({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        // The survivor carries its authoritative body — the real server builds this
        // from canonical/proposal; the client never invents section metadata.
        richStructureSection("Overview", ["Overview"], "frag:sec_overview", "# Overview\nPeer-visible body.\n"),
        richStructureSection("Promoted", ["Promoted"], "frag:sec_promoted"),
      ],
    } as WsServerEvent);

    // The replacement section appears (preview count grows) — never a vanish with
    // nothing in its place…
    await waitFor(() => {
      expect(container.querySelectorAll(".doc-prose").length).toBe(2);
    });
    // …the survivor's content is retained (not silently lost)…
    expect(screen.getByText(/Peer-visible body/)).toBeDefined();
    // …and no canonical refetch occurred — the event payload was the source.
    expect(sectionsFetchCount).toBe(fetchesBeforeSplit);
  });
});
