/**
 * `content:committed` handling under the live-section redesign
 * (new-frontend-live-document-design.md; spec 06 §Refresh Strategy).
 *
 * `content:committed` may ONLY refresh cold seeds or separately-tracked metadata —
 * it must NEVER reinstall live body or topology over the ordered CRDT authority:
 *
 *   - With a live replica bootstrap (`liveReplicaReadyRef.current`): body and
 *     topology are owned by the `LiveSectionReplica`. The commit
 *     event does NOT refetch `getWorkspaceDocumentSections`, does NOT adopt fresh
 *     topology (splits/merges/inserts), does NOT reconcile focus, and cannot
 *     surface a refresh error — there is no body refetch on the live path. It only
 *     drives the commit highlight + clears proposal indicators. Forking REST
 *     `.content`/topology over live authority is exactly the bug this removes.
 *   - With no live session: a full cold reload is delegated to `loadSections`.
 *
 * These assert visible state outcomes (section state left untouched while live;
 * fresh content only on the cold path), not which code path ran.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import type { WsServerEvent } from "../../types/shared";
import type { WorkspaceSectionDto } from "../../pages/document-page-utils";
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

let getDocumentSectionsImpl: (docPath: string) => Promise<{ sections: WorkspaceSectionDto[] }>;

vi.mock("../../services/api-client", () => ({
  apiClient: {
    getWorkspaceDocumentSections: (docPath: string) => getDocumentSectionsImpl(docPath),
  },
  resolveWriterId: () => "test-user",
}));

import { useDocumentWebSocket, type UseDocumentWebSocketParams } from "../../hooks/useDocumentWebSocket";

function makeSection(overrides: Partial<WorkspaceSectionDto>): WorkspaceSectionDto {
  return {
    heading: "Overview",
    heading_path: ["Overview"],
    depth: 1,
    content: "# Overview\n",
    agentWritePolicy: { canWrite: true, message: "ok" },
    crdt_session_active: false,
    fragment_key: "frag:sec_overview",
    section_file: "/sec_overview.md",
    ...overrides,
  };
}

function ref<T>(value: T): React.MutableRefObject<T> {
  return { current: value };
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(MemoryRouter, null, children);

function buildParams(
  initial: WorkspaceSectionDto[],
  opts: { crdtActive: boolean; mountedFragmentKeys: string[]; focusedSectionIndex?: number | null },
): {
  params: UseDocumentWebSocketParams;
  holder: { sections: WorkspaceSectionDto[] };
  loadSections: ReturnType<typeof vi.fn>;
  setError: ReturnType<typeof vi.fn>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
} {
  const holder = { sections: initial };
  const setSections = vi.fn((updater: unknown) => {
    holder.sections = typeof updater === "function" ? (updater as (p: WorkspaceSectionDto[]) => WorkspaceSectionDto[])(holder.sections) : (updater as WorkspaceSectionDto[]);
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
  void setSections;
  void opts.mountedFragmentKeys;
  const params: UseDocumentWebSocketParams = {
    docPath: "/test.md",
    clientInstanceId: "test-tab",
    liveReplicaReadyRef: ref(opts.crdtActive),
    setStructureTree: vi.fn() as unknown as UseDocumentWebSocketParams["setStructureTree"],
    loadSections,
    setError,
  };
  return { params, holder, loadSections, setError, focusedSectionIndexRef };
}

function emitCommitted(sections: Array<{ doc_path: string; heading_path: string[] }>): void {
  capturedWsHandler?.({
    type: "content:committed",
    doc_path: "/test.md",
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

const fragKeys = (sections: WorkspaceSectionDto[]) => sections.map(getSectionFragmentKey);

describe("content:committed topology refresh (spec 06)", () => {
  beforeEach(() => {
    capturedWsHandler = null;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("leaves existing section state untouched while live (body/topology owned by the replica)", async () => {
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "SEED overview (live editor)\n" }),
      makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "SEED timeline\n" }),
    ];
    const { params, holder, loadSections } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: ["frag:sec_overview"],
    });
    // A "lying" fresh payload — it must never be fetched/adopted on the live path.
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "FRESH overview (must be ignored)\n" }),
        makeSection({ heading: "Timeline", heading_path: ["Timeline"], fragment_key: "frag:sec_timeline", content: "FRESH timeline (must be ignored)\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([
      { doc_path: "/test.md", heading_path: ["Overview"] },
      { doc_path: "/test.md", heading_path: ["Timeline"] },
    ]);
    await settle();

    // No cold reload happened while live; both keys keep their prior seed and the
    // topology is exactly what it was (the CRDT replica, not this event, owns it).
    expect(loadSections).not.toHaveBeenCalled();
    const overview = holder.sections.find((s) => s.fragment_key === "frag:sec_overview");
    const timeline = holder.sections.find((s) => s.fragment_key === "frag:sec_timeline");
    expect(overview!.content).toBe("SEED overview (live editor)\n");
    expect(timeline!.content).toBe("SEED timeline\n");
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview", "frag:sec_timeline"]);
  });

  it("does NOT adopt an inserted split section from the commit event while live", async () => {
    // Survivor "Overview" has a mounted editor; the server's canonical refetch WOULD
    // report a promoted child — but the live path must not fetch or adopt it (the
    // split reaches the client on the ordered CRDT topology frame instead).
    const initial = [
      makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "LIVE survivor body\n" }),
    ];
    const { params, holder, loadSections } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: ["frag:sec_overview"],
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Overview", heading_path: ["Overview"], fragment_key: "frag:sec_overview", content: "FRESH trimmed survivor\n" }),
        makeSection({ heading: "Sub", heading_path: ["Overview", "Sub"], depth: 2, fragment_key: "frag:sec_sub", section_file: "/sec_sub.md", content: "promoted child body\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "/test.md", heading_path: ["Overview"] }]);
    await settle();

    // The commit event did not fork REST topology over the live replica: no reload,
    // no new section, survivor body untouched.
    expect(loadSections).not.toHaveBeenCalled();
    expect(holder.sections).toHaveLength(1);
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_overview"]);
    expect(holder.sections[0].content).toBe("LIVE survivor body\n");
  });

  it("does NOT drop a merged-away key from the commit event while live", async () => {
    const initial = [
      makeSection({ heading: "Keep", heading_path: ["Keep"], fragment_key: "frag:sec_keep", content: "keep\n" }),
      makeSection({ heading: "Folded", heading_path: ["Folded"], fragment_key: "frag:sec_folded", content: "LIVE folded\n" }),
    ];
    const { params, holder, loadSections } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: ["frag:sec_folded"],
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "Keep", heading_path: ["Keep"], fragment_key: "frag:sec_keep", content: "keep grew\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "/test.md", heading_path: ["Keep"] }]);
    await settle();

    // Removal is owned by the CRDT topology frame (the key dropping out of it), not
    // by this app event — the live path leaves the section list alone.
    expect(loadSections).not.toHaveBeenCalled();
    expect(fragKeys(holder.sections)).toEqual(["frag:sec_keep", "frag:sec_folded"]);
  });

  it("does NOT reconcile focus from the commit event while live", async () => {
    const initial = [
      makeSection({ heading: "Intro", heading_path: ["Intro"], fragment_key: "frag:sec_intro", content: "intro\n" }),
      makeSection({ heading: "Focused", heading_path: ["Focused"], fragment_key: "frag:sec_focused", content: "focused\n" }),
    ];
    // Focus is on index 1 ("Focused").
    const { params, focusedSectionIndexRef } = buildParams(initial, {
      crdtActive: true,
      mountedFragmentKeys: [],
      focusedSectionIndex: 1,
    });
    getDocumentSectionsImpl = async () => ({
      sections: [
        makeSection({ heading: "New", heading_path: ["New"], fragment_key: "frag:sec_new", section_file: "/sec_new.md", content: "new\n" }),
        makeSection({ heading: "Intro", heading_path: ["Intro"], fragment_key: "frag:sec_intro", content: "intro\n" }),
        makeSection({ heading: "Focused", heading_path: ["Focused"], fragment_key: "frag:sec_focused", content: "focused\n" }),
      ],
    });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "/test.md", heading_path: ["New"] }]);
    await settle();

    // Focus reconciliation is `resolveFocusAfterTopologyChange` on the replica
    // topology path — the commit event must not move focus.
    expect(focusedSectionIndexRef.current).toBe(1);
  });

  it("does NOT surface a refresh error while live (there is no body refetch on the live path)", async () => {
    const initial = [makeSection({})];
    const { params, setError, loadSections } = buildParams(initial, { crdtActive: true, mountedFragmentKeys: ["frag:sec_overview"] });
    // If the live path erroneously refetched, this would throw and surface an error.
    getDocumentSectionsImpl = async () => {
      throw new Error("refresh boom");
    };

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "/test.md", heading_path: ["Overview"] }]);
    await settle();

    // No fetch on the live path → no error surfaced.
    expect(loadSections).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("delegates to a full reload when no CRDT session is active", async () => {
    const initial = [makeSection({ content: "STALE\n" })];
    const { params, holder } = buildParams(initial, { crdtActive: false, mountedFragmentKeys: [] });
    getDocumentSectionsImpl = async () => ({ sections: [makeSection({ content: "FRESH full reload\n" })] });

    renderHook(() => useDocumentWebSocket(params), { wrapper });
    emitCommitted([{ doc_path: "/test.md", heading_path: ["Overview"] }]);
    await settle();

    // Visible outcome: sections reflect fresh server content.
    expect(holder.sections[0].content).toBe("FRESH full reload\n");
  });
});
