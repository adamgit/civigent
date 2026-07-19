/**
 * E6 (restored for the redesign): a section that is present on the live replica
 * topology must NOT silently vanish because a lagging / cross-client app-WS
 * `doc:structure-changed` payload omits it. In the redesign the ordered CRDT frame
 * is the SOLE authority for live existence (todolist 357/05): while the replica is
 * ready, hub structure payloads are non-authoritative and must not drop or rewrite
 * a live section. A section only disappears when the replica TOPOLOGY drops it.
 *
 * The pre-redesign version guarded against silent vanish under the app-WS adopt
 * path; this rewrite asserts the redesign page contract: hub payload is inert while
 * ready, and a genuine CRDT-frame removal is what unmounts the section.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
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
const promoteToEditor = vi.fn(async () => {});
const demoteToObserver = vi.fn(async () => {});

const ALPHA_BODY = "ALPHA_LIVE_BODY";
const BETA_BODY = "BETA_LIVE_BODY";
const HUB_ADOPTED_BODY = "HUB_ADOPTED_BODY_MUST_NOT_PAINT";

const paintMarkdown = vi.fn((id: SectionId, seed: string) => {
  if (!replicaReady) return seed;
  const key = SectionId.text(id);
  if (key === "section::alpha") return `# Alpha\n\n${ALPHA_BODY}\n`;
  if (key === "section::beta") return `# Beta\n\n${BETA_BODY}\n`;
  // Mirrors the real hook: after ready, off-topology paint is a caller bug.
  throw new Error(`paintMarkdown: section "${key}" is not in the live topology; seed paint is illegal after the replica is ready.`);
});

const useLiveSectionReplicaMock = vi.fn(
  (params: { docPath: string | null; onSessionEnded?: () => void }) => {
    void params;
    return {
      isCurrentlyLiveAuthority: replicaReady,
      replicaGeneration: 1,
      replica: replicaReady
        ? {
            isCurrentlyLiveAuthority: true,
            getTopology: () => replicaTopology,
            isPending: () => false,
            isBlocked: () => false,
            getPendingSectionKeys: () => [],
            isPublishPauseMirrorActive: () => false,
            findInTopology: (id: SectionId) => ({
              id,
              readMarkdown: () => paintMarkdown(id, ""),
              isEditable: () => true,
              createEditorBinding: () => { throw new Error("findInTopology must not produce a binding in tests"); },
            }),
            getLiveSection: (id: SectionId) => ({
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
      (props: { binding?: { fragmentKey?: string }; onReady?: () => void }, _ref: unknown) => {
        const fk = props.binding?.fragmentKey;
        React.useEffect(() => {
          props.onReady?.();
        }, []);
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

// REST snapshot carries both sections (canonical), but live existence is the
// replica topology's job while ready.
const sectionsResponse = {
  sections: [
    {
      heading: "Alpha",
      heading_path: ["Alpha"],
      depth: 1,
      content: "# Alpha\nseed alpha\n",
      humanInvolvement_score: 0,
      crdt_session_active: true,
      fragment_key: "section::alpha",
      section_file: "sec_alpha.md",
    },
    {
      heading: "Beta",
      heading_path: ["Beta"],
      depth: 1,
      content: "# Beta\nseed beta\n",
      humanInvolvement_score: 0,
      crdt_session_active: true,
      fragment_key: "section::beta",
      section_file: "sec_beta.md",
    },
  ],
};

function docTree() {
  return (
    <MemoryRouter initialEntries={["/docs/e6.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="e6.md" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("E6: cross-client silent-vanish guard — hub payload cannot drop a live section", () => {
  beforeEach(() => {
    capturedWsHandler = null;
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
        return jsonResponse({
          structure: [
            { heading: "Alpha", level: 1, children: [] },
            { heading: "Beta", level: 1, children: [] },
          ],
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("a lagging hub structure payload omitting Beta does NOT vanish it; only the CRDT topology can", async () => {
    // Ready with both sections live.
    replicaReady = true;
    replicaTopology = [
      { id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] },
      { id: SectionId.brand("section::beta"), headingPath: ["Beta"] },
    ];
    const { rerender } = render(docTree());

    await waitFor(() => {
      expect(screen.getByText(new RegExp(ALPHA_BODY))).toBeDefined();
    });
    expect(screen.getByText(new RegExp(BETA_BODY))).toBeDefined();

    // A cross-client / lagging hub doc:structure-changed that DROPS Beta and rewrites
    // Alpha's body. While the replica is authoritative this is non-authoritative and
    // must be ignored — Beta must not silently vanish; Alpha must not adopt hub body.
    act(() => {
      capturedWsHandler?.({
        type: "doc:structure-changed",
        doc_path: "e6.md",
        sections: [
          {
            heading: "Alpha",
            heading_path: ["Alpha"],
            depth: 1,
            content: `# Alpha\n${HUB_ADOPTED_BODY}\n`,
            agentWritePolicy: { canWrite: true, message: "ok" },
            crdt_session_active: true,
            fragment_key: "section::alpha",
            section_file: "sec_alpha.md",
          },
        ],
      } as unknown as WsServerEvent);
    });

    // Guard: Beta survives, Alpha keeps its live body, hub body never paints.
    expect(screen.getByText(new RegExp(BETA_BODY))).toBeDefined();
    expect(screen.getByText(new RegExp(ALPHA_BODY))).toBeDefined();
    expect(screen.queryByText(new RegExp(HUB_ADOPTED_BODY))).toBeNull();

    // Only a genuine ordered CRDT frame removes Beta: the replica topology drops it.
    replicaTopology = [{ id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] }];
    rerender(docTree());

    await waitFor(() => {
      expect(screen.queryByText(new RegExp(BETA_BODY))).toBeNull();
    });
    // Alpha (still in topology) remains — the removal was surgical, not a wipe.
    expect(screen.getByText(new RegExp(ALPHA_BODY))).toBeDefined();
  });
});
