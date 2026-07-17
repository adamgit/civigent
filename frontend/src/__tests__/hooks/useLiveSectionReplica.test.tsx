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

const editorTransports: { doc: Y.Doc; connect: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../../services/crdt-transport", () => ({
  CrdtTransport: class {
    doc: Y.Doc;
    connect = vi.fn();
    destroy = vi.fn();
    setPublishPauseBarrier = vi.fn();
    constructor(_docPath: string, opts: { doc?: Y.Doc }) {
      this.doc = opts.doc!;
      editorTransports.push({ doc: this.doc, connect: this.connect, destroy: this.destroy });
    }
  },
}));

// eslint-disable-next-line import/first
import { useLiveSectionReplica } from "../../hooks/useLiveSectionReplica";

const ALPHA = "section::alpha";

function bootstrapFrameBytes(doc: Y.Doc): { yjs: Uint8Array; state: WireLiveSectionsState } {
  const src = new Y.Doc();
  const frag = src.getXmlFragment(ALPHA);
  src.transact(() =>
    updateYFragment(src, frag, markdownToProseMirrorNode("# Alpha\n\nlive body"), { mapping: new Map(), isOMark: new Map() }),
  );
  return {
    yjs: Y.encodeStateAsUpdate(src),
    state: { topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"] }], blocked_section_ids: [], pending_sections: [], publish_pause_join_mirror: "not_in_pause" },
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
    expect(result.current.hasAuthoritativeBootstrap).toBe(false);
    // Pre-ready: paint the seed.
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toBe("cold seed");

    const provider = providers[0];
    expect(provider.connect).toHaveBeenCalled();
    const { yjs, state } = bootstrapFrameBytes(provider.doc);

    act(() => {
      provider.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "s", state }, yjs));
    });

    expect(result.current.hasAuthoritativeBootstrap).toBe(true);
    expect(result.current.topology.map((r) => SectionId.text(r.id))).toEqual([ALPHA]);
    // After ready: paint the live fragment, NOT the seed.
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toContain("live body");
  });

  it("calls onSessionEnded on session end", () => {
    const onSessionEnded = vi.fn();
    renderHook(() => useLiveSectionReplica({ docPath: "/doc.md", onSessionEnded }));
    act(() => {
      providers[0].events.onSessionEnded!();
    });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it("SESSION-END (4021): drops live authority and reverts consumers to cold seeds", () => {
    // The page's session-end callback also refetches REST seeds; here we assert the
    // replica half of that contract — live authority is dropped so paint reverts to
    // the seed — and that the page callback still fires so the seed refetch runs.
    const onSessionEnded = vi.fn();
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md", onSessionEnded }));

    // Reach ready via a bootstrap; paint now comes from the live fragment.
    const provider = providers[0];
    const { yjs, state } = bootstrapFrameBytes(provider.doc);
    act(() => {
      provider.events.onLiveSectionFrame!(0x14, frameBody({ doc_session_id: "s", state }, yjs));
    });
    expect(result.current.hasAuthoritativeBootstrap).toBe(true);
    expect(result.current.paintMarkdown(SectionId.brand(ALPHA), "cold seed")).toContain("live body");

    // Session end (4021): live authority is dropped — not-ready, empty topology,
    // and paint falls back to the cold seed. The page callback fires so it can
    // refetch REST seeds.
    act(() => {
      provider.events.onSessionEnded!();
    });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(result.current.hasAuthoritativeBootstrap).toBe(false);
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
});
