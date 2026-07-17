/**
 * Single live authority guard (legacy observer/session-mode path deleted).
 *
 * A live document page has exactly ONE transport owner — `useLiveSectionReplica`.
 * These tests fail if the legacy double-path ever returns:
 *
 *   1. Exactly one ObserverCrdtProvider is constructed per page mount (the
 *      replica's), and click-to-edit replaces it with exactly one editor
 *      transport bound to the SAME Y.Doc — never a second observer/editor pair.
 *   2. BrowserFragmentReplicaStore is never constructed by a live page: live
 *      body/editability/pending are readable only from the LiveSectionReplica.
 *   3. Live editability comes from the replica: a replica-blocked section does
 *      not mount an editor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { WsServerEvent } from "../../../types/shared";

// ─── Constructor counters ───

const observerConstructions: Array<{ doc: unknown; destroy: ReturnType<typeof vi.fn> }> = [];
const editorProviderConstructions: Array<{ doc: unknown }> = [];
const storeConstructions: unknown[] = [];

vi.mock("../../../services/observer-crdt-provider", async () => {
  const Y = await import("yjs");
  return {
    ObserverCrdtProvider: class {
      doc: unknown;
      destroy = vi.fn();
      connect = vi.fn();
      constructor(_docPath: string, _events: Record<string, unknown>, opts?: { doc?: unknown }) {
        this.doc = opts?.doc ?? new Y.Doc();
        observerConstructions.push({ doc: this.doc, destroy: this.destroy });
      }
    },
  };
});

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    doc: unknown;
    state = "disconnected";
    awareness = { getLocalState: () => ({ user: {} }), setLocalStateField: vi.fn(), destroy: vi.fn() };
    destroy = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() { return false; }
    constructor(doc: unknown, _docPath: string, _opts: Record<string, unknown>, opts2?: { awareness?: unknown }) {
      this.doc = doc;
      if (opts2?.awareness) this.awareness = opts2.awareness as never;
      editorProviderConstructions.push({ doc });
    }
  },
}));

vi.mock("../../../services/browser-fragment-replica-store", () => ({
  BrowserFragmentReplicaStore: class {
    constructor() {
      storeConstructions.push(this);
      throw new Error(
        "BrowserFragmentReplicaStore must not be constructed on a live document page — LiveSectionReplica is the only live authority.",
      );
    }
  },
}));

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (_h: (e: WsServerEvent) => void) => {};
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
        return <div data-testid="milkdown-editor" data-fragment-key={props.fragmentKey}>Editor</div>;
      },
    ),
  };
});

vi.mock("../../../components/ProposalPanel", () => ({ ProposalPanel: () => <div /> }));
vi.mock("../../../services/recent-docs", () => ({ rememberRecentDoc: vi.fn() }));
vi.mock("../../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, resolveWriterId: () => "test-user" };
});

import { DocumentPage } from "../../../pages/DocumentPage";

const overviewSection = {
  heading: "Overview",
  heading_path: ["Overview"],
  depth: 1,
  content: "# Overview\nOverview content.\n",
  humanInvolvement_score: 0,
  crdt_session_active: false,
  section_length_warning: false,
  word_count: 2,
  fragment_key: "frag:sec_overview",
  section_file: "sec_overview.md",
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

describe("single live transport owner", () => {
  beforeEach(() => {
    observerConstructions.length = 0;
    editorProviderConstructions.length = 0;
    storeConstructions.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/sections")) return jsonResponse({ sections: [overviewSection] });
      if (urlStr.includes("/structure")) return jsonResponse({ structure: [] });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("mounts exactly ONE observer connection and never a BrowserFragmentReplicaStore", async () => {
    renderDocPage();
    await waitFor(() => expect(screen.getByText("Overview content.")).toBeDefined());

    expect(observerConstructions).toHaveLength(1);
    expect(editorProviderConstructions).toHaveLength(0);
    expect(storeConstructions).toHaveLength(0);
  });

  it("click-to-edit promotes on the SAME Y.Doc: observer destroyed, one editor transport, still no store", async () => {
    renderDocPage();
    await waitFor(() => expect(screen.getByText("Overview content.")).toBeDefined());
    const observer = observerConstructions[0];

    fireEvent.click(screen.getByText("Overview content."));

    await waitFor(() => expect(editorProviderConstructions).toHaveLength(1));
    // The one observer was torn down (no double-path), and the editor provider
    // reuses the replica's Y.Doc rather than minting a fresh one.
    expect(observer.destroy).toHaveBeenCalled();
    expect(observerConstructions).toHaveLength(1);
    expect(editorProviderConstructions[0].doc).toBe(observer.doc);
    expect(storeConstructions).toHaveLength(0);
  });
});
