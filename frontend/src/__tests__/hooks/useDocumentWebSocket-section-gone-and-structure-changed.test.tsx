/**
 * `section:gone` and `doc:structure-changed` detach flow (spec 05
 * §"Section block-state events" and spec 06 §"Refresh Strategy").
 *
 * The origin client's Milkdown editor must become non-writable — and its CRDT
 * binding torn down — as soon as the server says a section is gone or drops
 * its fragment_key from the authoritative section list. Yjs cannot delete
 * top-level XmlFragments from `ydoc.share`, so a still-mounted ySyncPlugin
 * would otherwise echo further keystrokes into a fragment the server has
 * already unregistered (post-merge) — which then hits the acceptance-gate
 * "no layout identity" throw on ingress.
 *
 * These assert the two hand-offs:
 *   (1) `section:gone` → `store.getSectionEditabilityForKey === "gone"`;
 *   (2) `doc:structure-changed` dropping a fragment_key produces a sections
 *       list that omits that key — even if focus was on it (focus reconciles
 *       to null and the section is no longer rendered → editor unmounts).
 *
 * The DocumentCanvas render guard (`if (crdtGone) return null;`) is already
 * covered by `document-canvas-blockstate.test.tsx`; these tests cover the WS
 * event → state hand-off that feeds it.
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
} {
  const holder = { sections: initial };
  const setSections = vi.fn((updater: unknown) => {
    holder.sections = typeof updater === "function"
      ? (updater as (p: DocumentSection[]) => DocumentSection[])(holder.sections)
      : (updater as DocumentSection[]);
  });
  const focusedSectionIndexRef = ref<number | null>(opts.focusedSectionIndex ?? null);
  const params: UseDocumentWebSocketParams = {
    decodedDocPath: "test.md",
    clientInstanceId: "client-1",
    sectionsRef: ref(initial),
    setSections: setSections as unknown as UseDocumentWebSocketParams["setSections"],
    transportRef: ref(null),
    focusedSectionIndexRef,
    mountedEditorFragmentKeysRef: ref(new Set(opts.mountedFragmentKeys ?? [])),
    pendingStructureRefocusRef: ref<string[] | null>(null),
    storeRef: ref(opts.store),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections: vi.fn(async () => []),
    setError: vi.fn(),
  };
  return { params, holder, focusedSectionIndexRef };
}

function emit(event: Record<string, unknown>): void {
  act(() => { capturedWsHandler?.(event as unknown as WsServerEvent); });
}

const fragKeys = (sections: DocumentSection[]) => sections.map(getSectionFragmentKey);

describe("section:gone WS delivery (spec 05 §Section block-state events)", () => {
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

  it("routes a matching-doc `section:gone` into the replica store", () => {
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

    expect(store.getSectionEditabilityForKey("frag:sec_overview")).toBe("gone");
  });

  it("ignores a `section:gone` for a different doc_path", () => {
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

describe("doc:structure-changed dropping a fragment_key (spec 06 §Refresh Strategy)", () => {
  beforeEach(() => { capturedWsHandler = null; });
  afterEach(() => { vi.clearAllMocks(); });

  it("adopts a fresh layout that omits a merged-away fragment_key", () => {
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview\n" }),
      makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "timeline\n" }),
    ];
    const { params, holder } = buildParams(initial, { store: null });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview + folded timeline\n" }),
      ],
    });

    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview"]);
    expect(holder.sections.find((s) => s.fragment_key === "frag:sec_timeline")).toBeUndefined();
  });

  it("forces focus onto the merge survivor when the focused fragment is dropped by the structure change", () => {
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "overview\n" }),
      makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "timeline\n" }),
    ];
    // Focus is on Timeline (index 1) — the one the server merges away into Overview.
    const { params, holder, focusedSectionIndexRef } = buildParams(initial, {
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

    // Observing the delete forces focus OFF the removed Timeline key onto its
    // surviving predecessor Overview (index 0) — never left on the dead key, and
    // not cleared to null (which would drop the caret entirely).
    expect(focusedSectionIndexRef.current).toBe(0);
    expect(holder.sections[focusedSectionIndexRef.current!].fragment_key).toBe("frag:sec_overview");
    // And the dropped fragment_key is no longer in the list to render.
    expect(holder.sections.find((s) => s.fragment_key === "frag:sec_timeline")).toBeUndefined();
  });

  it("drops a fragment_key from the layout even when its editor was mounted", () => {
    // The merged-away section had a mounted editor. adoptFreshSectionLayout keeps
    // `content` (as a cold seed) only for keys STILL PRESENT in `fresh`; a
    // fragment absent from `fresh` is unconditionally dropped — mounted or not —
    // which is what forces the editor to unmount at the next render.
    const initial = [
      makeSection({ heading: "Keep", heading_path: ["Keep"], fragment_key: "frag:sec_keep", content: "keep\n" }),
      makeSection({ heading: "Folded", heading_path: ["Folded"], fragment_key: "frag:sec_folded", content: "LIVE folded body\n" }),
    ];
    const { params, holder } = buildParams(initial, {
      store: null,
      mountedFragmentKeys: ["frag:sec_folded"],
    });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "doc:structure-changed",
      doc_path: "test.md",
      sections: [
        makeSection({ heading: "Keep", heading_path: ["Keep"], fragment_key: "frag:sec_keep", content: "keep\n" }),
      ],
    });

    expect(fragKeys(holder.sections)).toEqual(["frag:sec_keep"]);
    expect(holder.sections.find((s) => s.fragment_key === "frag:sec_folded")).toBeUndefined();
  });

  it("ignores a `doc:structure-changed` for a different doc_path", () => {
    const initial = [makeSection({ fragment_key: "frag:sec_overview" })];
    const { params, holder } = buildParams(initial, { store: null });
    renderHook(() => useDocumentWebSocket(params), { wrapper });

    emit({
      type: "doc:structure-changed",
      doc_path: "other.md",
      sections: [], // would drop everything if not gated by doc_path
    });

    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview"]);
  });
});
