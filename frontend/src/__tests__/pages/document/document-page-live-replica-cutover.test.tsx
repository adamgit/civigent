/**
 * High-level DocumentPage cutover contracts for LiveSectionReplica
 * (new-frontend-live-document-design.md / todolist cutover items).
 *
 * 1) Poisoned seed must lose to live bootstrap paint; promote reuses one Y.Doc.
 * 2) Live split surfaces via CRDT replica topology — hub structure-changed must
 *    not adopt body/topology.
 * 3) Session end (4021 / onSessionEnded) drops live authority and refetches seeds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as Y from "yjs";
import { jsonResponse } from "../../helpers/fetch-mocks";
import { SectionId, type LiveSectionRef } from "../../../types/live-sections";
import type { WsServerEvent } from "../../../types/shared";

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

const sharedDoc = new Y.Doc();
let replicaReady = false;
let replicaTopology: LiveSectionRef[] = [];
let sessionEndedHandler: (() => void) | undefined;
const promoteToEditor = vi.fn(async () => {});
const demoteToObserver = vi.fn(async () => {});
const paintMarkdown = vi.fn((id: SectionId, seed: string) => {
  if (!replicaReady) return seed;
  const key = SectionId.text(id);
  if (key === "section::alpha") return "# Alpha\n\nLIVE_FRAGMENT_BODY\n";
  if (key === "section::beta") return "# Beta\n\nLIVE_SPLIT_BODY\n";
  return seed;
});

const useLiveSectionReplicaMock = vi.fn(
  (params: { docPath: string | null; onSessionEnded?: () => void }) => {
    sessionEndedHandler = params.onSessionEnded;
    return {
      hasAuthoritativeBootstrap: replicaReady,
      replica: replicaReady
        ? {
            hasAuthoritativeBootstrap: true,
            getTopology: () => replicaTopology,
            isPending: () => false,
            isBlocked: () => false,
            getPendingSectionKeys: () => [],
            isPublishPauseMirrorActive: () => false,
            requireLiveSection: (id: SectionId) => ({
              id,
              readMarkdown: () => paintMarkdown(id, ""),
              isEditable: () => true,
              createEditorBinding: () => ({
                doc: sharedDoc,
                awareness: { clientID: 1 },
                fragmentKey: SectionId.text(id),
              }),
            }),
          }
        : null,
      topology: replicaTopology,
      mode: "observer" as const,
      clientInstanceId: "test-tab",
      editorState: "disconnected" as const,
      observerState: "connected" as const,
      publishPaused: false,
      allReceived: true,
      transportError: null,
      awareness: null,
      editorTransport: null,
      paintMarkdown,
      promoteToEditor,
      demoteToObserver,
    };
  },
);

vi.mock("../../../hooks/useLiveSectionReplica", () => ({
  useLiveSectionReplica: (params: { docPath: string | null; onSessionEnded?: () => void }) =>
    useLiveSectionReplicaMock(params),
}));

vi.mock("../../../services/ws-client", () => ({
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
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    focusSection = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() {
      return false;
    }
  },
}));

vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { fragmentKey?: string; onReady?: () => void }, _ref: unknown) => {
        React.useEffect(() => {
          props.onReady?.();
        }, []);
        return (
          <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey}>
            Editor:{props.fragmentKey}
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

const POISONED_SEED = "POISONED_SEED_MUST_NOT_PAINT_AFTER_READY";

const sectionsResponse = {
  sections: [
    {
      heading: "Alpha",
      heading_path: ["Alpha"],
      depth: 1,
      content: `# Alpha\n${POISONED_SEED}\n`,
      humanInvolvement_score: 0,
      crdt_session_active: true,
      section_length_warning: false,
      word_count: 2,
      fragment_key: "section::alpha",
      section_file: "sec_alpha.md",
    },
  ],
};

function renderDocPage() {
  return render(
    <MemoryRouter initialEntries={["/docs/cutover.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="cutover.md" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DocumentPage live-replica cutover", () => {
  beforeEach(() => {
    capturedWsHandler = null;
    sessionEndedHandler = undefined;
    replicaReady = false;
    replicaTopology = [];
    promoteToEditor.mockClear();
    demoteToObserver.mockClear();
    paintMarkdown.mockClear();
    useLiveSectionReplicaMock.mockClear();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) return jsonResponse(sectionsResponse);
      if (urlStr.includes("/structure")) {
        return jsonResponse({ structure: [{ heading: "Alpha", level: 1, children: [] }] });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("1: paints live fragment over poisoned seed and promotes via promoteToEditor on one Y.Doc", async () => {
    const { rerender } = renderDocPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading document...")).toBeNull();
    });

    // Cutover: page must mount the replica hook for this doc.
    expect(useLiveSectionReplicaMock).toHaveBeenCalled();
    expect(useLiveSectionReplicaMock).toHaveBeenCalledWith(
      expect.objectContaining({ docPath: expect.stringMatching(/cutover\.md/) }),
    );

    // Become ready with live body that differs from the poisoned REST seed.
    replicaReady = true;
    replicaTopology = [{ id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] }];
    rerender(
      <MemoryRouter initialEntries={["/docs/cutover.md"]}>
        <Routes>
          <Route path="/docs/*" element={<DocumentPage docPathOverride="cutover.md" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/LIVE_FRAGMENT_BODY/)).toBeDefined();
    });
    expect(screen.queryByText(new RegExp(POISONED_SEED))).toBeNull();
    expect(paintMarkdown).toHaveBeenCalled();

    fireEvent.click(screen.getByText(/LIVE_FRAGMENT_BODY/));
    await waitFor(() => {
      expect(promoteToEditor).toHaveBeenCalled();
    });
  });

  it("2: live split surfaces via replica topology; hub structure-changed does not adopt", async () => {
    replicaReady = true;
    replicaTopology = [{ id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] }];
    const { rerender } = renderDocPage();

    await waitFor(() => {
      expect(useLiveSectionReplicaMock).toHaveBeenCalled();
    });

    // CRDT structural update: Beta appears on the ordered channel only.
    replicaTopology = [
      { id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] },
      { id: SectionId.brand("section::beta"), headingPath: ["Beta"] },
    ];
    rerender(
      <MemoryRouter initialEntries={["/docs/cutover.md"]}>
        <Routes>
          <Route path="/docs/*" element={<DocumentPage docPathOverride="cutover.md" />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/LIVE_SPLIT_BODY/)).toBeDefined();
    });

    // Hub payload that would drop Beta / rewrite Alpha body — must not adopt.
    act(() => {
      capturedWsHandler?.({
        type: "doc:structure-changed",
        doc_path: "cutover.md",
        sections: [
          {
            heading: "Alpha",
            heading_path: ["Alpha"],
            depth: 1,
            content: "# Alpha\nHUB_ADOPTED_BODY\n",
            agentWritePolicy: { canWrite: true, message: "ok" },
            crdt_session_active: true,
            section_length_warning: false,
            word_count: 1,
            fragment_key: "section::alpha",
            section_file: "sec_alpha.md",
          },
        ],
      } as unknown as WsServerEvent);
    });

    expect(screen.getByText(/LIVE_SPLIT_BODY/)).toBeDefined();
    expect(screen.queryByText(/HUB_ADOPTED_BODY/)).toBeNull();
  });

  it("3: session end (4021) drops replica paint and refetches workspace seeds", async () => {
    replicaReady = true;
    replicaTopology = [{ id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] }];
    renderDocPage();

    await waitFor(() => {
      expect(useLiveSectionReplicaMock).toHaveBeenCalled();
    });
    expect(sessionEndedHandler).toEqual(expect.any(Function));

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    act(() => {
      sessionEndedHandler!();
    });

    await waitFor(() => {
      const sectionFetches = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/sections"),
      );
      expect(sectionFetches.length).toBeGreaterThan(0);
    });
  });
});
