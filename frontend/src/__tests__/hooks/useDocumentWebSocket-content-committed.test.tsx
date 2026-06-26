/**
 * `content:committed` topology refresh (spec 06 §Refresh Strategy; spec 05
 * §Proposal Publication).
 *
 * When a CRDT session is active, a `content:committed` canonical-refresh hint must
 * adopt the FRESH server topology (splits, merges, renames, inserts, deletes are
 * reflected even while editors are mounted) while PRESERVING the live local content
 * of any section whose Milkdown editor is currently mounted. Matching is by opaque
 * fragment_key — never positional index or heading text. With no CRDT session, a
 * full reload is delegated to `loadSections`.
 *
 * These assert visible state outcomes (resulting topology + preserved/refreshed
 * content + surfaced errors), not which refresh code path ran.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import type { WsServerEvent } from "../../types/shared";
import type { DocumentSection } from "../../pages/document-page-utils";
import { getSectionFragmentKey } from "../../pages/document-page-utils";

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../services/ws-client", () => ({
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

let getDocumentSectionsImpl: (docPath: string) => Promise<{ sections: DocumentSection[] }>;

vi.mock("../../services/api-client", () => ({
  apiClient: {
    getWorkspaceDocumentSections: (docPath: string) => getDocumentSectionsImpl(docPath),
  },
  resolveWriterId: () => "test-user",
}));

import { useDocumentWebSocket, type UseDocumentWebSocketParams } from "../../hooks/useDocumentWebSocket";

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

function ref<T>(value: T): React.MutableRefObject<T> {
  return { current: value };
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

function buildParams(
  initial: DocumentSection[],
  opts: { crdtActive: boolean; mountedFragmentKeys: string[]; focusedSectionIndex?: number | null },
): {
  params: UseDocumentWebSocketParams;
  holder: { sections: DocumentSection[] };
  loadSections: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
} {
  const holder = { sections: initial };
  const setSections = vi.fn((updater: unknown) => {
    holder.sections = typeof updater === "function" ? (updater as (p: DocumentSection[]) => DocumentSection[])(holder.sections) : (updater as DocumentSection[]);
  });
  // The no-CRDT branch delegates the refresh to loadSections; simulate the real
  // DocumentPage by having it adopt the fresh server sections into state.
  const loadSections = vi.fn(async (docPath: string) => {
    const fresh = (await getDocumentSectionsImpl(docPath)).sections;
    holder.sections = fresh;
    return fresh;
  });
  const setError = vi.fn();
  const focusedSectionIndexRef = ref<number | null>(opts.focusedSectionIndex ?? null);
  const params: UseDocumentWebSocketParams = {
    decodedDocPath: "test.md",
    sectionsRef: ref(initial),
    setSections: setSections as unknown as UseDocumentWebSocketParams["setSections"],
    transportRef: ref(opts.crdtActive ? ({} as never) : null),
    focusedSectionIndexRef,
    mountedEditorFragmentKeysRef: ref(new Set(opts.mountedFragmentKeys)),
    pendingStructureRefocusRef: ref<string[] | null>(null),
    storeRef: ref(null),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections,
    setError,
  };
  return { params, holder, loadSections, setError, focusedSectionIndexRef };
}

function emitCommitted(sections: Array<{ doc_path: string; heading_path: string[] }>): void {
  capturedWsHandler?.({
    type: "content:committed",
    doc_path: "test.md",
    writer_display_name: "Collaborator",
    writer_type: "human",
    sections,
    commit_sha: "deadbeef",
  } as WsServerEvent);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const fragKeys = (sections: DocumentSection[]) => sections.map(getSectionFragmentKey);

describe("content:committed topology refresh (spec 06)", () => {
  beforeEach(() => {
    capturedWsHandler = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preserves mounted editor content while refreshing non-mounted previews", async () => {
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "STALE overview (live editor)\n" }),
      makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "STALE timeline\n" }),
    ];
    const { params, holder } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: ["frag:sec_overview"],
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "FRESH overview (must be ignored)\n" }),
        makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "FRESH timeline\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([
      { doc_path: "test.md", heading_path: ["Overview"] },
      { doc_path: "test.md", heading_path: ["Timeline"] },
    ]);
    await settle();

    const overview = holder.sections.find((s) => s.fragment_key === "frag:sec_overview");
    const timeline = holder.sections.find((s) => s.fragment_key === "frag:sec_timeline");
    // Mounted editor's live content preserved; non-mounted preview refreshed.
    expect(overview!.content).toBe("STALE overview (live editor)\n");
    expect(timeline!.content).toBe("FRESH timeline\n");
    // Topology matches fresh server topology, by fragment_key.
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview", "frag:sec_timeline"]);
  });

  it("adopts an inserted promoted split section while a neighboring editor stays mounted", async () => {
    // Survivor "Overview" has a mounted editor; server splits out a promoted child.
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "LIVE survivor body\n" }),
    ];
    const { params, holder } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: ["frag:sec_overview"],
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "FRESH trimmed survivor\n" }),
        makeSection({ heading: "Sub", heading_path: ["Overview", "Sub"], depth: 2, fragment_key: "frag:sec_sub", section_file: "sec_sub.md", content: "promoted child body\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "test.md", heading_path: ["Overview"] }]);
    await settle();

    // Old count was NOT kept — the promoted section is now present.
    expect(holder.sections).toHaveLength(2);
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview", "frag:sec_sub"]);
    const sub = holder.sections.find((s) => s.fragment_key === "frag:sec_sub");
    expect(sub!.content).toBe("promoted child body\n");
    // The mounted survivor's live content is not clobbered.
    const survivor = holder.sections.find((s) => s.fragment_key === "frag:sec_overview");
    expect(survivor!.content).toBe("LIVE survivor body\n");
  });

  it("drops a section whose fragment_key is absent from the fresh response, even if it had a mounted editor", async () => {
    const initial = [
      makeSection({ heading: "Keep", heading_path: ["Keep"], fragment_key: "frag:sec_keep", content: "keep\n" }),
      makeSection({ heading: "Folded", heading_path: ["Folded"], fragment_key: "frag:sec_folded", content: "LIVE folded\n" }),
    ];
    // The folded section had a mounted editor — it must STILL be dropped because the
    // server no longer reports its fragment_key (merged away).
    const { params, holder } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: ["frag:sec_folded"],
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Keep", heading_path: ["Keep"], fragment_key: "frag:sec_keep", content: "keep grew\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "test.md", heading_path: ["Keep"] }]);
    await settle();

    expect(fragKeys(holder.sections)).toEqual(["frag:sec_keep"]);
    expect(holder.sections.find((s) => s.fragment_key === "frag:sec_folded")).toBeUndefined();
  });

  it("reconciles focus by fragment identity across a topology change", async () => {
    const initial = [
      makeSection({ heading: "Intro", heading_path: ["Intro"], fragment_key: "frag:sec_intro", content: "intro\n" }),
      makeSection({ heading: "Focused", heading_path: ["Focused"], fragment_key: "frag:sec_focused", content: "focused\n" }),
    ];
    // Focus is on index 1 ("Focused").
    const { params, holder, focusedSectionIndexRef } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: [],
      focusedSectionIndex: 1,
    });
    // Server inserts a new section at the top → Focused moves to index 2.
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "New", heading_path: ["New"], fragment_key: "frag:sec_new", section_file: "sec_new.md", content: "new\n" }),
        makeSection({ heading: "Intro", heading_path: ["Intro"], fragment_key: "frag:sec_intro", content: "intro\n" }),
        makeSection({ heading: "Focused", heading_path: ["Focused"], fragment_key: "frag:sec_focused", content: "focused\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "test.md", heading_path: ["New"] }]);
    await settle();

    expect(holder.sections[focusedSectionIndexRef.current!].fragment_key).toBe("frag:sec_focused");
    expect(focusedSectionIndexRef.current).toBe(2);
  });

  it("clears focus when the focused fragment no longer exists", async () => {
    const initial = [
      makeSection({ heading: "Stay", heading_path: ["Stay"], fragment_key: "frag:sec_stay", content: "stay\n" }),
      makeSection({ heading: "Gone", heading_path: ["Gone"], fragment_key: "frag:sec_gone", content: "gone\n" }),
    ];
    const { params, focusedSectionIndexRef } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: [],
      focusedSectionIndex: 1,
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Stay", heading_path: ["Stay"], fragment_key: "frag:sec_stay", content: "stay\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "test.md", heading_path: ["Stay"] }]);
    await settle();

    expect(focusedSectionIndexRef.current).toBeNull();
  });

  it("surfaces an error when the post-commit refresh fetch fails", async () => {
    const initial = [makeSection({})];
    const { params, setError } = buildParams(initial, { crdtActive: true, mountedFragmentKeys: ["frag:sec_overview"] });
    getDocumentSectionsImpl = async () => {
      throw new Error("refresh boom");
    };

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "test.md", heading_path: ["Overview"] }]);
    await settle();

    expect(setError).toHaveBeenCalledWith(expect.stringContaining("refresh boom"));
  });

  it("delegates to a full reload when no CRDT session is active", async () => {
    const initial = [makeSection({ content: "STALE\n" })];
    const { params, holder } = buildParams(initial, { crdtActive: false, mountedFragmentKeys: [] });
    getDocumentSectionsImpl = async () => ({ sections: [makeSection({ content: "FRESH full reload\n" })] });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "test.md", heading_path: ["Overview"] }]);
    await settle();

    // Visible outcome: sections reflect fresh server content.
    expect(holder.sections[0].content).toBe("FRESH full reload\n");
  });
});
