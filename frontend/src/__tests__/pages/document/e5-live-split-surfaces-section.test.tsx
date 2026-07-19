/**
 * E5 (restored for the redesign): a LIVE split surfaces a new editable section on
 * the PAGE via the `LiveSectionReplica` ordered topology — WITHOUT a
 * `content:committed`, WITHOUT an app-WS `doc:structure-changed` adopt, and WITHOUT
 * a REST `/sections` refetch. The survivor's live body is preserved (the direct
 * regression for the "edited section vanishes" symptom) and the survivor is painted
 * from the live fragment, never the poisoned REST seed.
 *
 * This is the page-level contract (todolist: "CI locks page wiring, not only hook
 * unit tests"). The pre-redesign version asserted the OPPOSITE mechanism (adopt the
 * new section straight off the app-WS `doc:structure-changed` payload); that path is
 * deleted by the redesign, so this rewrite drives the split purely through replica
 * topology + paint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
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

const ALPHA_SURVIVOR_BODY = "ALPHA_SURVIVOR_LIVE_BODY";
const BETA_SPLIT_BODY = "BETA_SPLIT_LIVE_BODY";
const POISONED_SEED = "POISONED_REST_SEED_MUST_NOT_PAINT";

const paintMarkdown = vi.fn((id: SectionId, seed: string) => {
  if (!replicaReady) return seed;
  const key = SectionId.text(id);
  if (key === "section::alpha") return `# Alpha\n\n${ALPHA_SURVIVOR_BODY}\n`;
  if (key === "section::beta") return `# Beta\n\n${BETA_SPLIT_BODY}\n`;
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

// Only Alpha exists in the canonical REST snapshot; its content carries a poisoned
// seed that must never reach paint once the live replica is authoritative. Beta
// exists ONLY on the live topology (an uncommitted split — invisible to canonical).
const sectionsResponse = {
  sections: [
    {
      heading: "Alpha",
      heading_path: ["Alpha"],
      depth: 1,
      content: `# Alpha\n${POISONED_SEED}\n`,
      humanInvolvement_score: 0,
      crdt_session_active: true,
      fragment_key: "section::alpha",
      section_file: "sec_alpha.md",
    },
  ],
};

function docTree() {
  return (
    <MemoryRouter initialEntries={["/docs/e5.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPathOverride="e5.md" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("E5: live split surfaces the new section on the page via replica topology", () => {
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

  it("surfaces the split section AND preserves the survivor's live body, with no REST refetch and no app-WS adopt", async () => {
    // Start ready with a single live section (Alpha), painted from the live fragment.
    replicaReady = true;
    replicaTopology = [{ id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] }];
    const { rerender } = render(docTree());

    await waitFor(() => {
      expect(screen.getByText(new RegExp(ALPHA_SURVIVOR_BODY))).toBeDefined();
    });
    // The survivor paints from the live fragment — never the poisoned REST seed.
    expect(screen.queryByText(new RegExp(POISONED_SEED))).toBeNull();

    // Baseline the fetch mock: any /sections call AFTER this point would be a
    // canonical refetch, which a live uncommitted split must NOT trigger.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    // LIVE split: Beta appears on the ordered CRDT topology only. No content:committed,
    // no app-WS doc:structure-changed — we never invoke capturedWsHandler.
    replicaTopology = [
      { id: SectionId.brand("section::alpha"), headingPath: ["Alpha"] },
      { id: SectionId.brand("section::beta"), headingPath: ["Beta"] },
    ];
    rerender(docTree());

    // The new section surfaces on the page via replica topology + paint.
    await waitFor(() => {
      expect(screen.getByText(new RegExp(BETA_SPLIT_BODY))).toBeDefined();
    });
    // The survivor did NOT vanish and still shows its live body.
    expect(screen.getByText(new RegExp(ALPHA_SURVIVOR_BODY))).toBeDefined();
    expect(screen.queryByText(new RegExp(POISONED_SEED))).toBeNull();

    // The split surfaced purely from the replica — no canonical /sections refetch.
    const sectionRefetches = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/sections"),
    );
    expect(sectionRefetches).toHaveLength(0);
  });
});
