/**
 * `section:gone` and `doc:structure-changed` are NO LONGER live authorities in
 * `useDocumentWebSocket` (live-section redesign, new-frontend-live-document-design.md).
 *
 * Live topology / existence / editability now arrive on the ordered DocSession
 * CRDT channel via `LiveSectionReplica` (bootstrap + update frames). The
 * application-WebSocket `section:blocked|unblocked|gone` and `doc:structure-changed`
 * events are therefore demoted:
 *
 *   (1) `section:gone` (and blocked/unblocked) is NOT routed into the live replica
 *       store — the hook ignores it as a live authority. Removal reaches the
 *       replica by the section's fragment_key dropping out of the CRDT topology
 *       frame (covered by the replica tests), not from this unordered app event.
 *   (2) `doc:structure-changed` is a COLD-invalidation HINT only: a page with no
 *       live replica refetches the workspace section seeds (`loadSections`). It
 *       does NOT adopt live topology/body in place, and does NOT perform focus
 *       reconciliation (that is `resolveFocusAfterTopologyChange` on the replica
 *       topology path — see `resolve-focus-after-topology-change.test.ts`).
 *
 * Both are still gated by `doc_path` so a foreign document's event is ignored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { WsServerEvent } from "../../types/shared";
import type { DocumentSection } from "../../pages/document-page-utils";
import { getSectionFragmentKey } from "../../pages/document-page-utils";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store";

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (h: WsEventHandler) => { capturedWsHandler = h; };
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../services/api-client", () => ({
  apiClient: { getWorkspaceDocumentSections: async () => ({ sections: [] }) },
  resolveWriterId: () => "test-user",
}));

import { useDocumentWebSocket, type UseDocumentWebSocketParams } from "../../hooks/useDocumentWebSocket";

function ref<T>(v: T): React.MutableRefObject<T> { return { current: v }; }

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

function makeSection(overrides: Partial<DocumentSection>): DocumentSection {
  return {
    heading: "Overview",
    heading_path: ["Overview"],
    depth: 1,
    content: "# Overview\n",
    agentWritePolicy: { canWrite: true, message: "ok" },
    crdt_session_active: false,
    section_length_warning: false,
    word_count: 2,
    fragment_key: "frag:sec_overview",
    section_file: "sec_overview.md",
    ...overrides,
  };
}

function buildParams(
  initial: DocumentSection[],
  opts: { store: BrowserFragmentReplicaStore | null; mountedFragmentKeys?: string[]; focusedSectionIndex?: number | null },
): {
  params: UseDocumentWebSocketParams;
  holder: { sections: DocumentSection[] };
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  loadSections: ReturnType<typeof vi.fn>;
} {
  const holder = { sections: initial };
  const setSections = vi.fn((updater: unknown) => {
    holder.sections = typeof updater === "function"
      ? (updater as (p: DocumentSection[]) => DocumentSection[])(holder.sections)
      : (updater as DocumentSection[]);
  });
  const focusedSectionIndexRef = ref<number | null>(opts.focusedSectionIndex ?? null);
  const loadSections = vi.fn(async () => []);
  const params: UseDocumentWebSocketParams = {
    decodedDocPath: "test.md",
    clientInstanceId: "client-1",
    liveReplicaReadyRef: ref(opts.store !== null),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections: loadSections as unknown as UseDocumentWebSocketParams["loadSections"],
    setError: vi.fn(),
  };
  return { params, holder, focusedSectionIndexRef, loadSections };
}

function emit(event: Record<string, unknown>): void {
  act(() => { capturedWsHandler?.(event as unknown as WsServerEvent); });
}

const fragKeys = (sections: DocumentSection[]) => sections.map(getSectionFragmentKey);

describe("section:gone WS delivery is no longer a live authority", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let store: BrowserFragmentReplicaStore;

  beforeEach(() => {
    capturedWsHandler = null;
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    store = new BrowserFragmentReplicaStore(doc, awareness);
  });

  afterEach(() => {
    vi.clearAllMocks();
    awareness.destroy();
    doc.destroy();
  });

  it("does NOT route a matching-doc `section:gone` into the replica store", () => {
    const initial = [makeSection({ fragment_key: "frag:sec_overview" })];
    const { params } = buildParams(initial, { store });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    expect(store.getSectionEditabilityForKey("frag:sec_overview")).toBe("editable");

    emit({
      type: "section:gone",
      doc_path: "test.md",
      fragment_key: "frag:sec_overview",
      heading_path: ["Overview"],
    });

    // The app-WS event is ignored: editability follows the CRDT topology frame,
    // not this unordered event. The store is untouched.
    expect(store.getSectionEditabilityForKey("frag:sec_overview")).toBe("editable");
  });

  it("ignores a `section:gone` for a different doc_path (still untouched)", () => {
    const initial = [makeSection({ fragment_key: "frag:sec_overview" })];
    const { params } = buildParams(initial, { store });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "section:gone",
      doc_path: "other.md",
      fragment_key: "frag:sec_overview",
      heading_path: ["Overview"],
    });

    expect(store.getSectionEditabilityForKey("frag:sec_overview")).toBe("editable");
  });
});

describe("doc:structure-changed is a cold-invalidation refetch hint (spec 06 §Refresh Strategy)", () => {
  beforeEach(() => { capturedWsHandler = null; });
  afterEach(() => { vi.clearAllMocks(); });

  it("refetches the workspace section seeds (loadSections) instead of adopting live topology in place", () => {
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview\n" }),
      makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "timeline\n" }),
    ];
    const { params, holder, loadSections } = buildParams(initial, { store: null });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview + folded timeline\n" }),
      ],
    });

    // Cold-invalidation: the hook triggers a workspace-seed refetch for this doc…
    expect(loadSections).toHaveBeenCalledWith("test.md");
    // …and does NOT adopt the app-hub `sections` payload into live state in place
    // (no dropping keys off the current list from the unordered app event).
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview", "frag:sec_timeline"]);
  });

  it("does not perform focus reconciliation from the app event (that is the replica's job)", () => {
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview\n" }),
      makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "timeline\n" }),
    ];
    // Focus is on Timeline (index 1).
    const { params, focusedSectionIndexRef, loadSections } = buildParams(initial, {
      store: null,
      focusedSectionIndex: 1,
    });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview + folded timeline\n" }),
      ],
    });

    // The cold refetch fired; focus is left to the replica topology path
    // (`resolveFocusAfterTopologyChange`), NOT mutated by this hook.
    expect(loadSections).toHaveBeenCalledWith("test.md");
    expect(focusedSectionIndexRef.current).toBe(1);
  });

  it("ignores a `doc:structure-changed` for a different doc_path (no refetch)", () => {
    const initial = [makeSection({ fragment_key: "frag:sec_overview" })];
    const { params, holder, loadSections } = buildParams(initial, { store: null });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "doc:structure-changed",
      doc_path: "other.md",
      sections: [], // would drop everything if it were adopted in place
    });

    expect(loadSections).not.toHaveBeenCalled();
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview"]);
  });
});
