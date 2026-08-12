/**
 * useLiveSectionReplica — cold-seed / ready-gate / session-end handoff.
 *
 * The ObserverCrdtProvider is mocked to capture the events it is constructed
 * with (so the test can drive `onLiveSectionFrame` / `onSessionEnded`) and to
 * apply routed Yjs updates onto the shared doc passed in `opts.doc`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import { SectionId } from "../../types/live-sections";
import type { WireLiveSectionsState } from "../../types/shared";

interface CapturedProvider {
  events: Record<string, ((...a: unknown[]) => void) | undefined>;
  doc: Y.Doc;
  connect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}
const providers: CapturedProvider[] = [];

vi.mock("../../services/observer-crdt-provider", () => ({
  ObserverCrdtProvider: class {
    doc: Y.Doc;
    connect = vi.fn();
    destroy = vi.fn();
    constructor(_docPath: string, events: Record<string, unknown>, opts?: { doc?: Y.Doc }) {
      this.doc = opts!.doc!;
      providers.push({ events: events as CapturedProvider["events"], doc: this.doc, connect: this.connect, destroy: this.destroy });
    }
  },
}));

const editorTransports: { doc: Y.Doc; opts: Record<string, ((...a: unknown[]) => void) | undefined>; connect: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../../services/crdt-transport", () => ({
  CrdtTransport: class {
    doc: Y.Doc;
    connect = vi.fn();
    destroy = vi.fn();
    setPublishPauseBarrier = vi.fn();
    constructor(_docPath: string, opts: { doc?: Y.Doc }) {
      this.doc = opts.doc!;
      editorTransports.push({ doc: this.doc, opts: opts as unknown as Record<string, ((...a: unknown[]) => void) | undefined>, connect: this.connect, destroy: this.destroy });
    }
  },
}));

// eslint-disable-next-line import/first
import { useLiveSectionReplica } from "../../hooks/useLiveSectionReplica";

const ALPHA = "section::alpha";

/** A bootstrap frame as a fresh server DocSession emits it: a brand-new Y.Doc,
 *  so each call has a Yjs history disjoint from every other call's. */
function bootstrapFrameBytes(markdown = "# Alpha\n\nlive body"): { yjs: Uint8Array; state: WireLiveSectionsState } {
  const src = new Y.Doc();
  const frag = src.getXmlFragment(ALPHA);
  src.transact(() =>
    updateYFragment(src, frag, markdownToProseMirrorNode(markdown), { mapping: new Map(), isOMark: new Map() }),
  );
  return {
    yjs: Y.encodeStateAsUpdate(src),
    state: { topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"], heading_level: 1 }], blocked_section_ids: [], pending_sections: [], publish_pause_join_mirror: "not_in_pause" },
  };
}

/** Build a bootstrap frame body (opcode stripped) matching backend/frontend codec. */
function frameBody(header: unknown, trailing: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(4 + json.length + trailing.length);
  buf[0] = (json.length >>> 24) & 0xff;
  buf[1] = (json.length >>> 16) & 0xff;
  buf[2] = (json.length >>> 8) & 0xff;
  buf[3] = json.length & 0xff;
  buf.set(json, 4);
  buf.set(trailing, 4 + json.length);
  return buf;
}

describe("useLiveSectionReplica", () => {
  beforeEach(() => {
    providers.length = 0;
    editorTransports.length = 0;
  });

  it("paints cold seed until ready, then live fragment body after bootstrap", () => {
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md" }));
    expect(result.current.isCurrentlyLiveAuthority).toBe(false);
    // Pre-ready: paint the seed.
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toBe("cold seed");

    const provider = providers[0];
    expect(provider.connect).toHaveBeenCalled();
    const { yjs, state } = bootstrapFrameBytes();

    act(() => {
      provider.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "s", state }, yjs));
    });

    expect(result.current.isCurrentlyLiveAuthority).toBe(true);
    expect(result.current.topology.map((r) => SectionId.text(r.id))).toEqual([ALPHA]);
    // After ready: paint the live fragment, NOT the seed.
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toContain("live body");
  });

  it("after ready, painting an off-topology id THROWS instead of resurrecting the seed", () => {
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md" }));
    const provider = providers[0];
    const { yjs, state } = bootstrapFrameBytes();
    act(() => {
      provider.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "s", state }, yjs));
    });
    expect(result.current.isCurrentlyLiveAuthority).toBe(true);

    // "section::ghost" is not in the bootstrap topology: once live authority
    // exists, seed paint for it is illegal (it would revive pre-live REST text
    // for a removed section) — fail loud instead.
    expect(() => result.current.paintMarkdown(SectionId.brand("section::ghost"), "ghost seed")).toThrow(
      /not in the live topology/,
    );
  });

  it("calls onSessionEnded on session end", () => {
    const onSessionEnded = vi.fn();
    renderHook(() => useLiveSectionReplica({ docPath: "/doc.md", onSessionEnded }));
    act(() => {
      providers[0].events.onSessionEnded!();
    });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it("SESSION-END (4021): parks the replica as read-only display until the page's completion call, then replaces the pipeline", () => {
    // 4021 with a page handler: the ended provider is destroyed on the spot (it
    // can never reconnect its old doc), but the replica is PARKED — topology and
    // paint keep serving the ended session's content — until the page calls the
    // one-shot completion function, which mints the fresh observer pipeline.
    let complete: (() => void) | null = null;
    const onSessionEnded = vi.fn((c: () => void) => { complete = c; });
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md", onSessionEnded }));

    // Reach ready via a bootstrap; paint now comes from the live fragment.
    const provider = providers[0];
    const { yjs, state } = bootstrapFrameBytes();
    act(() => {
      provider.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "s", state }, yjs));
    });
    expect(result.current.isCurrentlyLiveAuthority).toBe(true);
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toContain("live body");

    // Session end (4021): connection destroyed, no replacement provider yet,
    // and the parked replica still paints the ended session's content.
    act(() => {
      provider.events.onSessionEnded!();
    });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(provider.destroy).toHaveBeenCalled();
    expect(providers).toHaveLength(1);
    expect(result.current.isCurrentlyLiveAuthority).toBe(true);
    expect(result.current.topology.map((r) => SectionId.text(r.id))).toEqual([ALPHA]);
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toContain("live body");

    // Completion: fresh observer on a fresh doc; live authority gone, topology
    // empty, paint falls back to the cold seed. The completion is one-shot.
    act(() => {
      complete!();
      complete!();
    });
    expect(providers).toHaveLength(2);
    expect(providers[1].doc).not.toBe(provider.doc);
    expect(providers[1].connect).toHaveBeenCalled();
    expect(result.current.isCurrentlyLiveAuthority).toBe(false);
    expect(result.current.topology).toEqual([]);
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toBe("cold seed");
  });

  it("does not open a socket when docPath is null", () => {
    renderHook(() => useLiveSectionReplica({ docPath: null }));
    expect(providers).toHaveLength(0);
  });

  it("promotes observer → editor on the SAME doc without replacing the replica", async () => {
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md" }));
    const replicaBefore = result.current.replica;
    const observer = providers[0];
    const sharedDoc = observer.doc;
    expect(result.current.mode).toBe("observer");

    await act(async () => {
      await result.current.promoteToEditor();
    });

    expect(result.current.mode).toBe("editor");
    // Observer socket torn down; editor socket opened on the SAME shared doc.
    expect(observer.destroy).toHaveBeenCalled();
    expect(editorTransports).toHaveLength(1);
    expect(editorTransports[0].doc).toBe(sharedDoc);
    expect(editorTransports[0].connect).toHaveBeenCalled();
    // Replica is NOT replaced.
    expect(result.current.replica).toBe(replicaBefore);

    await act(async () => {
      await result.current.demoteToObserver();
    });

    expect(result.current.mode).toBe("observer");
    // Editor torn down; a fresh observer opened on the SAME doc; replica kept.
    expect(editorTransports[0].destroy).toHaveBeenCalled();
    expect(providers[1].doc).toBe(sharedDoc);
    expect(result.current.replica).toBe(replicaBefore);
  });

  it("EDITOR 4022 (document replaced): reason selects the rejoin mode — normal replacement keeps editing, stale rejection demotes to observer", async () => {
    const onSessionReinit = vi.fn();
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md", onSessionReinit }));
    const gen0 = result.current.replicaGeneration;
    await act(async () => {
      await result.current.promoteToEditor();
    });
    const editor = editorTransports[0];
    const editorDoc = editor.doc;

    // Normal replacement (restore): the editor provider does not reconnect;
    // the hook must retire the old doc and rejoin as EDITOR on a fresh one.
    act(() => {
      editor.opts.onSessionReinit!("document_replaced");
    });

    expect(editor.destroy).toHaveBeenCalled();
    expect(onSessionReinit).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe("editor");
    expect(result.current.replicaGeneration).toBeGreaterThan(gen0);
    const freshEditor = editorTransports[editorTransports.length - 1];
    expect(freshEditor).not.toBe(editor);
    expect(freshEditor.doc).not.toBe(editorDoc);
    expect(freshEditor.connect).toHaveBeenCalled();
    expect(result.current.isCurrentlyLiveAuthority).toBe(false);

    // Stale-session rejection: a stale tab must not displace the active
    // editor — it rejoins as OBSERVER on another fresh doc.
    act(() => {
      freshEditor.opts.onSessionReinit!("stale_doc_session");
    });

    expect(freshEditor.destroy).toHaveBeenCalled();
    expect(result.current.mode).toBe("observer");
    const freshObserver = providers[providers.length - 1];
    expect(freshObserver.doc).not.toBe(freshEditor.doc);
    expect(freshObserver.connect).toHaveBeenCalled();
  });

  it("EDITOR 4024 (admin force-rebuild): fresh pipeline that preserves editing", async () => {
    const onSessionReinit = vi.fn();
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md", onSessionReinit }));
    await act(async () => {
      await result.current.promoteToEditor();
    });
    const editor = editorTransports[0];

    act(() => {
      editor.opts.onForceRebuild!();
    });

    expect(editor.destroy).toHaveBeenCalled();
    expect(onSessionReinit).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe("editor");
    const freshEditor = editorTransports[editorTransports.length - 1];
    expect(freshEditor).not.toBe(editor);
    expect(freshEditor.doc).not.toBe(editor.doc);
    expect(freshEditor.connect).toHaveBeenCalled();
  });

  it("SESSION TURNOVER: 4021 mints a fresh pipeline immediately — the next session's bootstrap binds the fresh doc, paint is exactly the new content", () => {
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md" }));
    const first = providers[0];
    const b1 = bootstrapFrameBytes();
    act(() => {
      first.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "sess-1", state: b1.state }, b1.yjs));
    });
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "seed")).toContain("live body");

    // 4021 — the session (and the server Y.Doc history behind it) is gone for
    // good. The hook replaces the pipeline ON the session-end event: the ended
    // session's provider is destroyed and a fresh observer on a fresh doc is
    // already connected — the poisoned doc can never receive another bootstrap.
    act(() => {
      first.events.onSessionEnded!();
    });
    expect(result.current.isCurrentlyLiveAuthority).toBe(false);
    expect(first.destroy).toHaveBeenCalled();
    expect(providers).toHaveLength(2);
    const second = providers[1];
    expect(second.doc).not.toBe(first.doc);
    expect(second.connect).toHaveBeenCalled();

    // The NEXT session bootstraps from a FRESH server doc: disjoint Yjs history,
    // edited content. Y.applyUpdate merges histories (it never replaces), so
    // applying it into the ended session's doc would paint both bodies. It
    // arrives on the NEW provider and binds the fresh unbound replica cleanly.
    const b2 = bootstrapFrameBytes("# Alpha\n\nsecond session body");
    act(() => {
      second.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "sess-2", state: b2.state }, b2.yjs));
    });
    const painted = result.current.paintMarkdown(SectionId.brand(ALPHA), "seed");
    expect(painted).toContain("second session body");
    // NOTHING of the ended session survives — no ghost body, no duplication.
    expect(painted).not.toContain("live body");
    expect(painted.split("second session body").length - 1).toBe(1);
  });
});
