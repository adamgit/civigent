/**
 * Publish-pause recovery must fully unfreeze editors.
 *
 * Bug: `useLiveSectionReplica` ORs the opcode pause flag with the live-sections
 * join mirror (`publish_pause_join_mirror`). Opcode `doc_publish_pause_end`
 * clears only the opcode side. A state frame stamped during the pause (or a
 * mid-pause bootstrap) can leave the mirror active with no clearing frame —
 * so `publishPaused` stays true forever and every editor stays readOnly.
 *
 * These tests assert the required recovery contract. They FAIL on the
 * current composition until pause_end (or an equivalent) clears the freeze.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import type { WireLiveSectionsState } from "../../types/shared";
import { CrdtProvider } from "../../services/crdt-provider";

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
      providers.push({
        events: events as CapturedProvider["events"],
        doc: this.doc,
        connect: this.connect,
        destroy: this.destroy,
      });
    }
  },
}));

const editorTransports: {
  doc: Y.Doc;
  opts: Record<string, ((...a: unknown[]) => void) | undefined>;
  connect: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}[] = [];
vi.mock("../../services/crdt-transport", () => ({
  CrdtTransport: class {
    doc: Y.Doc;
    connect = vi.fn();
    destroy = vi.fn();
    setPublishPauseBarrier = vi.fn();
    constructor(_docPath: string, opts: { doc?: Y.Doc }) {
      this.doc = opts.doc!;
      editorTransports.push({
        doc: this.doc,
        opts: opts as unknown as Record<string, ((...a: unknown[]) => void) | undefined>,
        connect: this.connect,
        destroy: this.destroy,
      });
    }
  },
}));

// eslint-disable-next-line import/first
import { useLiveSectionReplica } from "../../hooks/useLiveSectionReplica";

const ALPHA = "section::alpha";
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
const MSG_LIVE_SECTIONS_UPDATE = 0x15;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;

function seedYjs(markdown = "# Alpha\n\nbody"): Uint8Array {
  const src = new Y.Doc();
  src.transact(() =>
    updateYFragment(
      src,
      src.getXmlFragment(ALPHA),
      markdownToProseMirrorNode(markdown),
      { mapping: new Map(), isOMark: new Map() },
    ),
  );
  const update = Y.encodeStateAsUpdate(src);
  src.destroy();
  return update;
}

function wireState(
  mirror: WireLiveSectionsState["publish_pause_join_mirror"],
): WireLiveSectionsState {
  return {
    topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"], heading_level: 1 }],
    blocked_section_ids: [],
    pending_sections: [],
    publish_pause_join_mirror: mirror,
  };
}

function frameBody(header: unknown, trailing: Uint8Array = new Uint8Array()): Uint8Array {
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

describe("publish pause must not leave editors permanently frozen", () => {
  beforeEach(() => {
    providers.length = 0;
    editorTransports.length = 0;
  });

  it("after opcode pause_end, publishPaused is false even if a mid-pause state frame stamped the join mirror", async () => {
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md" }));
    const observer = providers[0];
    const yjs = seedYjs();

    act(() => {
      observer.events.onLiveSectionFrame!(
        MSG_LIVE_SECTIONS_BOOTSTRAP,
        frameBody({ doc_session_id: "s", state: wireState("not_in_pause") }, yjs),
      );
    });

    await act(async () => {
      await result.current.promoteToEditor();
    });
    const editor = editorTransports[0];

    // Legitimate publish handshake: pause_start → mid-pause live state → pause_end.
    // Mid-pause state frames are stamped with pause_active_editors_frozen while
    // the server pause FSM is active (e.g. pending_sections / acceptance updates).
    act(() => {
      editor.opts.onPublishPauseStart!();
    });
    expect(result.current.publishPaused).toBe(true);

    act(() => {
      editor.opts.onLiveSectionFrame!(
        MSG_LIVE_SECTIONS_UPDATE,
        frameBody({
          has_yjs_update: false,
          state: wireState("pause_active_editors_frozen"),
        }),
      );
    });
    expect(result.current.replica?.isPublishPauseMirrorActive()).toBe(true);
    expect(result.current.publishPaused).toBe(true);

    act(() => {
      editor.opts.onPublishPauseEnd!();
    });

    // Recovery contract: a completed pause must leave the page editable again.
    // Today this fails — opcode end cleared, join mirror did not.
    expect(result.current.replica?.isPublishPauseMirrorActive()).toBe(false);
    expect(result.current.publishPaused).toBe(false);
  });

  it("mid-pause joiner: pause_end notification alone must clear publishPaused (mirror was the only freeze signal)", async () => {
    const { result } = renderHook(() => useLiveSectionReplica({ docPath: "/doc.md" }));
    const observer = providers[0];
    const yjs = seedYjs();

    // Joined while pause was already active — bootstrap carries the join mirror.
    // Opcode pause_start was never seen on this socket.
    act(() => {
      observer.events.onLiveSectionFrame!(
        MSG_LIVE_SECTIONS_BOOTSTRAP,
        frameBody(
          { doc_session_id: "s", state: wireState("pause_active_editors_frozen") },
          yjs,
        ),
      );
    });
    expect(result.current.replica?.isPublishPauseMirrorActive()).toBe(true);
    expect(result.current.publishPaused).toBe(true);

    await act(async () => {
      await result.current.promoteToEditor();
    });
    const editor = editorTransports[0];

    // Even if the provider learns pause ended and notifies the hook (required
    // recovery; today the provider no-ops pause_end without a prior start),
    // clearing only the opcode ref is not enough while the mirror stays active.
    act(() => {
      editor.opts.onPublishPauseEnd!();
    });

    expect(result.current.replica?.isPublishPauseMirrorActive()).toBe(false);
    expect(result.current.publishPaused).toBe(false);
  });
});

describe("CrdtProvider pause_end must notify UI for mid-pause joiners", () => {
  class StubWebSocket extends EventTarget {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readonly OPEN = 1;
    readonly CLOSED = 3;
    readyState = 0;
    onopen: ((ev: Event) => unknown) | null = null;
    onmessage: ((ev: MessageEvent) => unknown) | null = null;
    sentMessages: Uint8Array[] = [];
    static lastInstance: StubWebSocket | null = null;
    constructor() {
      super();
      StubWebSocket.lastInstance = this;
    }
    send(data: ArrayBuffer | Uint8Array | string): void {
      if (typeof data === "string") return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      this.sentMessages.push(new Uint8Array(bytes));
    }
    close(): void {
      this.readyState = StubWebSocket.CLOSED;
    }
    receiveServerMessage(bytes: Uint8Array): void {
      this.onmessage?.(
        new MessageEvent("message", {
          data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }),
      );
    }
    open(): void {
      this.readyState = StubWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    }
  }

  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    StubWebSocket.lastInstance = null;
    globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  function buildSyncStep2(): Uint8Array {
    const d = new Y.Doc();
    const state = Y.encodeStateAsUpdate(d);
    const msg = new Uint8Array(1 + state.length);
    msg[0] = MSG_SYNC_STEP_2;
    msg.set(state, 1);
    d.destroy();
    return msg;
  }

  it("pause_end without a prior pause_start still fires onPublishPauseEnd", () => {
    const doc = new Y.Doc();
    const onPublishPauseEnd = vi.fn();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onPublishPauseEnd });
    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();
    ws.receiveServerMessage(buildSyncStep2());

    // Mid-pause joiner: never saw start; server still broadcasts pause_end to all.
    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));

    // Required so a join-mirror-only freeze can be cleared. Today this fails —
    // handlePublishPauseEnd no-ops when publishPaused was never set.
    expect(onPublishPauseEnd).toHaveBeenCalledTimes(1);
    expect(provider.isPublishPaused).toBe(false);

    provider.destroy();
  });
});
