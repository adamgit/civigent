import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

// --- WsClient mock ---

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

/** Build the rich, SERVER-AUTHORED section shape `doc:structure-changed` carries
 *  (identical to GET …/sections). The client never synthesizes these fields, so the
 *  test payload must be fully populated too. */
function richStructureSection(heading: string, headingPath: string[], fragmentKey: string) {
  return {
    heading,
    heading_path: headingPath,
    depth: headingPath.length,
    content: "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    fragment_key: fragmentKey,
    section_file: `${fragmentKey.replace(/^frag:/, "")}.md`,
  };
}

vi.mock("../../../services/ws-client", () => ({
  getAppWsTransportInfo: (() => {
    const snapshot = { kind: null, fallbackReason: null };
    return () => snapshot;
  })(),
  subscribeAppWsTransport: () => () => {},
  describeAppWsBroadcastFallback: () => "",
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
  },
}));

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
      (this._opts?.onBootstrapApplied as (() => void) | undefined)?.();
    };
    disconnect = vi.fn();
    destroy = vi.fn();
    focusSection = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() { return false; }
  },
}));

vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { binding?: { fragmentKey?: string }; onReady?: () => void }, _ref: unknown) => {
        const fk = props.binding?.fragmentKey;
        React.useEffect(() => { props.onReady?.(); }, []);
        return (
          <div data-testid="milkdown-editor" data-fragment-key={fk}>
            Editor:{fk}
          </div>
        );
      },
    ),
  };
});

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
        <Route path="/docs/*" element={<DocumentPage docPath="/test.md" />} />
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
              fragment_key: "frag:sec_root",
              section_file: "/sec_root.md",
            },
            {
              heading: "Overview",
              heading_path: ["Overview"],
              depth: 1,
              content: `# Overview\nOverview v${sectionsFetchCount}.\n`,
              humanInvolvement_score: 0,
              crdt_session_active: false,
              fragment_key: "frag:sec_overview",
              section_file: "/sec_overview.md",
            },
          ],
        });
      }
      if (urlStr.includes("/structure")) {
        return jsonResponse({ structure: [{ heading: "Overview", level: 1, children: [] }] });
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
        doc_path: "/test.md",
        writer_display_name: "Agent",
        writer_type: "agent",
        sections: [{ doc_path: "/test.md", heading_path: ["Overview"] }],
        commit_sha: "abc123",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(sectionsFetchCount).toBeGreaterThan(initialCount);
    });
  });

  // NOTE: the former "a LIVE doc:structure-changed split surfaces the new editable
  // section before content:committed" test was removed with the live-section
  // redesign. Live topology no longer rides the application-WebSocket
  // `doc:structure-changed` event (that in-place adoption was the second, unordered
  // live authority the redesign deletes). Live splits now surface via the ordered
  // DocSession CRDT channel through `LiveSectionReplica` — unit-covered by
  // `live-section-replica.test.ts` / `useLiveSectionReplica.test.tsx` /
  // `resolve-focus-after-topology-change.test.ts`. Page-level re-coverage lands when
  // DocumentPage adopts the replica (a separate item). On the app hub,
  // `doc:structure-changed` is now only a cold-invalidation refetch hint — asserted
  // by the `content:committed from another writer reloads sections` test above and
  // by `useDocumentWebSocket-section-gone-and-structure-changed.test.tsx`.
});
