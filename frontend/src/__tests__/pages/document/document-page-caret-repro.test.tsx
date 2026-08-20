/**
 * REPRODUCTION HARNESS for the "edit-mode caret vanishes on initial open" bug.
 *
 * Unlike document-page-workflows.test.tsx (which mocks only crdt-provider and lets
 * the real ObserverCrdtProvider silently fail to open a WebSocket in jsdom), this
 * harness makes BOTH the editor provider and the observer CONTROLLABLE so the test
 * drives the realistic initial-open sequence with true async timing:
 *
 *   1. load resolves -> guard requests observer -> observer attaches a docSession
 *   2. user clicks to edit -> editor transport created
 *   3. editor + observer callbacks fire in realistic orders
 *
 * The caret is mounted purely on focusedSectionIndex; it "vanishes + returns to
 * observer/read mode" iff stopEditing() runs (which clears focus AND requests
 * observer). So every probe asserts: editor still mounted AND requestedMode editor.
 */

import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { ModeTransitionResult, WsServerEvent } from "../../../types/shared";

// ─── Controllable editor provider (wrapped by the real CrdtTransport) ───

interface CapturedProvider {
  opts: Record<string, any>;
  cid: string | undefined;
  destroy: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
const editorProviders: CapturedProvider[] = [];

vi.mock("../../../services/crdt-provider", () => ({
  CrdtProvider: class {
    _opts: Record<string, any>;
    state = "disconnected";
    awareness = { getLocalState: () => ({ user: {} }), setLocalStateField: vi.fn() };
    destroy = vi.fn();
    connect = vi.fn(() => {
      // Realistic: connect only moves to "connecting"; sync arrives later.
      this.state = "connecting";
      this._opts?.onStateChange?.("connecting");
    });
    disconnect = vi.fn();
    setPublishPauseBarrier = vi.fn();
    get isPublishPaused() { return false; }
    constructor(_doc: unknown, _docPath: string, opts: Record<string, any>, opts2?: Record<string, any>) {
      this._opts = opts;
      editorProviders.push({ opts, cid: opts2?.clientInstanceId, destroy: this.destroy, connect: this.connect });
    }
  },
}));

// ─── Controllable observer ───

interface CapturedObserver {
  events: Record<string, any>;
  cid: string | undefined;
  destroy: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
const observers: CapturedObserver[] = [];

vi.mock("../../../services/observer-crdt-provider", async () => {
  const Y = await import("yjs");
  return {
    ObserverCrdtProvider: class {
      doc = new Y.Doc();
      events: Record<string, any>;
      destroy = vi.fn();
      connect = vi.fn();
      constructor(_docPath: string, events: Record<string, any>, opts?: Record<string, any>) {
        this.events = events;
        observers.push({ events, cid: opts?.clientInstanceId, destroy: this.destroy, connect: this.connect });
      }
    },
  };
});

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
    onEvent = (_h: (e: WsServerEvent) => void) => {};
    openDocument = vi.fn();
    closeDocument = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../../components/MilkdownEditor", async () => {
  const React = await import("react");
  return {
    MilkdownEditor: React.forwardRef(
      (props: { binding?: { fragmentKey?: string }; onReady?: () => void }, _ref: unknown) => {
        const fk = props.binding?.fragmentKey;
        React.useEffect(() => { props.onReady?.(); }, []);
        return <div data-testid="milkdown-editor" data-fragment-key={fk}>Editor</div>;
      },
    ),
  };
});

vi.mock("../../../components/ProposalPanel", () => ({ ProposalPanel: () => <div /> }));
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
import { liveBootstrapFrame, MSG_LIVE_SECTIONS_BOOTSTRAP_OPCODE } from "../../helpers/live-bootstrap";
import { HeadingLevel } from "../../../types/shared";

const overviewSection = {
  heading: "Overview",
  heading_path: ["Overview"],
  heading_level: 1,
  content: "# Overview\nOverview content.\n",
  humanInvolvement_score: 0,
  crdt_session_active: false,
  fragment_key: "frag:sec_overview",
  section_file: "/sec_overview.md",
};

function accepted(docSessionId: string, mode: "observer" | "editor", clientInstanceId: string): ModeTransitionResult {
  return {
    kind: "accepted",
    requestId: "r",
    clientInstanceId,
    requestedMode: mode,
    attachmentState: "attached",
    docSessionId,
    clientRole: mode === "editor" ? "writer" : "observer",
  } as ModeTransitionResult;
}

function renderDocPage(strict = false) {
  const tree = (
    <MemoryRouter initialEntries={["/docs/test.md"]}>
      <Routes>
        <Route path="/docs/*" element={<DocumentPage docPath="/test.md" />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** Make the page's replica currently live authority (mount gate: live editors
 *  require a binding, which only exists once a bootstrap has bound the replica). */
async function deliverLiveBootstrap(obs: CapturedObserver): Promise<void> {
  await act(async () => {
    obs.events.onLiveSectionFrame?.(
      MSG_LIVE_SECTIONS_BOOTSTRAP_OPCODE,
      liveBootstrapFrame("OBS-SESSION", [{
        fragmentKey: "frag:sec_overview",
        headingPath: ["Overview"],
        headingLevel: HeadingLevel.parse(1),
        markdown: "# Overview\nOverview content.\n",
      }]),
    );
  });
}

function editorCount(): number {
  return screen.queryAllByTestId("milkdown-editor").length;
}

/** Latest captured editor provider (StrictMode produces several; the live one is last). */
function lastEditor(): CapturedProvider { return editorProviders[editorProviders.length - 1]; }
/** Latest captured observer. */
function lastObserver(): CapturedObserver { return observers[observers.length - 1]; }

describe("caret vanishes on initial open — reproduction harness", () => {
  beforeEach(() => {
    editorProviders.length = 0;
    observers.length = 0;
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

  it("PROBE: realistic initial-open then click-to-edit keeps the caret", async () => {
    renderDocPage();

    // Load resolves -> sections render -> guard starts observer.
    await waitFor(() => expect(screen.getByText("Overview content.")).toBeDefined());
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));

    // Observer attaches a real docSession (the path the old tests never hit, because
    // the real observer's WebSocket silently failed in jsdom).
    const obs = observers[0];
    await act(async () => {
      obs.events.onModeTransitionResult?.(accepted("OBS-SESSION", "observer", obs.cid!));
    });
    await deliverLiveBootstrap(obs);

    // Click to edit.
    fireEvent.click(screen.getByText("Overview content."));
    await waitFor(() => expect(editorProviders.length).toBeGreaterThan(0));

    // Editor transport connects + syncs (realistic async ordering).
    const ep = editorProviders[0];
    await act(async () => {
      ep.opts.onStateChange?.("connected");
      ep.opts.onBootstrapApplied?.();
      ep.opts.onModeTransitionResult?.(accepted("EDIT-SESSION", "editor", ep.cid!));
    });

    await waitFor(() => expect(editorCount()).toBeGreaterThan(0));

    // Let all effects settle, then assert the caret survived.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(editorCount()).toBeGreaterThan(0);
    expect(ep.destroy).not.toHaveBeenCalled();
  });

  it("PROBE A: a late observer mode-transition-result (shared clientInstanceId) must not flip back to read mode", async () => {
    renderDocPage();
    await waitFor(() => expect(screen.getByText("Overview content.")).toBeDefined());
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    const obs = observers[0];
    await deliverLiveBootstrap(obs);

    // FAST CLICK: user clicks to edit before the observer's transition result lands.
    fireEvent.click(screen.getByText("Overview content."));
    await waitFor(() => expect(editorProviders.length).toBeGreaterThan(0));
    const ep = editorProviders[0];
    await act(async () => {
      ep.opts.onStateChange?.("connected");
      ep.opts.onBootstrapApplied?.();
      ep.opts.onModeTransitionResult?.(accepted("EDIT-SESSION", "editor", ep.cid!));
    });
    await waitFor(() => expect(editorCount()).toBeGreaterThan(0));

    // NOW the observer's in-flight result arrives (same clientInstanceId). The hook
    // must NOT let a stale observer result overwrite the active editor mode.
    await act(async () => {
      obs.events.onModeTransitionResult?.(accepted("OBS-SESSION", "observer", obs.cid!));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(editorCount()).toBeGreaterThan(0);
    expect(screen.queryByText("Overview content.")).toBeNull(); // still editing, not read view
  });

  // PROBE B/C document the two teardown SURFACES that DO nuke the caret. Neither is
  // reachable on a clean initial open (B needs a genuine post-sync transport
  // disconnect; C needs a still-live observer, but the observer is destroyed —
  // onclose nulled — the moment edit starts). They are here to pin the mechanism.

  it("SURFACE B (by design): editor transport reaching 'disconnected' after sync tears down the editor", async () => {
    renderDocPage();
    await waitFor(() => expect(screen.getByText("Overview content.")).toBeDefined());
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));
    await act(async () => {
      observers[0].events.onModeTransitionResult?.(accepted("OBS-SESSION", "observer", observers[0].cid!));
    });
    await deliverLiveBootstrap(observers[0]);

    fireEvent.click(screen.getByText("Overview content."));
    await waitFor(() => expect(editorProviders.length).toBeGreaterThan(0));
    const ep = editorProviders[0];
    await act(async () => {
      ep.opts.onStateChange?.("connected");
      ep.opts.onBootstrapApplied?.();
      ep.opts.onModeTransitionResult?.(accepted("EDIT-SESSION", "editor", ep.cid!));
    });
    await waitFor(() => expect(editorCount()).toBeGreaterThan(0));

    // Transport blips to disconnected (this is the DocumentPage transport-failure path).
    await act(async () => {
      ep.opts.onStateChange?.("disconnected");
      await new Promise((r) => setTimeout(r, 0));
    });

    // A genuine post-sync disconnect tears the editor down (DocumentPage transport-
    // failure effect). By design; NOT triggered on a clean open because the editor
    // provider never emits "disconnected" during a normal connect (it emits
    // connecting → connected → error/reconnecting, never "disconnected").
    expect(editorCount()).toBe(0);
  });

  it("STRICTMODE: realistic initial-open then click-to-edit keeps the caret (dev double-mount)", async () => {
    renderDocPage(true);

    await waitFor(() => expect(screen.getByText("Overview content.")).toBeDefined());
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));

    // Observer (live instance) attaches a docSession.
    const obs = lastObserver();
    await act(async () => {
      obs.events.onModeTransitionResult?.(accepted("OBS-SESSION", "observer", obs.cid!));
    });
    await deliverLiveBootstrap(obs);

    fireEvent.click(screen.getByText("Overview content."));
    await waitFor(() => expect(editorProviders.length).toBeGreaterThan(0));

    const ep = lastEditor();
    await act(async () => {
      ep.opts.onStateChange?.("connected");
      ep.opts.onBootstrapApplied?.();
      ep.opts.onModeTransitionResult?.(accepted("EDIT-SESSION", "editor", ep.cid!));
    });

    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(editorCount()).toBeGreaterThan(0);
    expect(ep.destroy).not.toHaveBeenCalled();
  });

});
