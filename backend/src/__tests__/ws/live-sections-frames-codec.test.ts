import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  encodeLiveSectionsBootstrap,
  decodeLiveSectionsBootstrap,
  encodeLiveSectionsUpdate,
  decodeLiveSectionsUpdate,
  decodeMessage,
} from "../../ws/crdt-ws-frames.js";
import type { WireLiveSectionsState } from "../../types/shared.js";

const STATE: WireLiveSectionsState = {
  topology: [
    { fragment_key: "section::__beforeFirstHeading__", heading_path: [] },
    { fragment_key: "section::alpha", heading_path: ["Alpha"] },
    { fragment_key: "section::beta", heading_path: ["Alpha", "Beta"] },
  ],
  blocked_section_ids: ["section::beta"],
  pending_sections: [
    { fragment_key: "section::alpha", writer_id: "u1", writer_display_name: "Ada" },
  ],
  publish_pause_join_mirror: "pause_active_editors_frozen",
};

function yUpdateFor(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment("section::alpha");
  doc.getText("scratch").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe("live-section frame codec (wire contract)", () => {
  it("bootstrap round-trips doc_session_id + full state + yjs_update, and tags the opcode", () => {
    const yjs = yUpdateFor("hello world");
    const bytes = encodeLiveSectionsBootstrap({ doc_session_id: "sess-1", state: STATE, yjs_update: yjs });

    expect(bytes[0]).toBe(MSG_LIVE_SECTIONS_BOOTSTRAP);
    const decodedMsg = decodeMessage(bytes)!;
    expect(decodedMsg.type).toBe(MSG_LIVE_SECTIONS_BOOTSTRAP);

    const frame = decodeLiveSectionsBootstrap(decodedMsg.payload);
    expect(frame.doc_session_id).toBe("sess-1");
    expect(frame.state).toEqual(STATE);
    expect(Array.from(frame.yjs_update)).toEqual(Array.from(yjs));

    // The trailing Yjs update reconstructs the same doc content.
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, frame.yjs_update);
    expect(rebuilt.getText("scratch").toString()).toBe("hello world");
  });

  it("update frame round-trips yjs_update + state together (one structural fact)", () => {
    const yjs = yUpdateFor("body");
    const frame = decodeLiveSectionsUpdate(
      decodeMessage(encodeLiveSectionsUpdate({ yjs_update: yjs, state: STATE }))!.payload,
    );
    expect(frame.state).toEqual(STATE);
    expect(frame.yjs_update).toBeDefined();
    expect(Array.from(frame.yjs_update!)).toEqual(Array.from(yjs));
  });

  it("content-only update carries yjs_update and no state", () => {
    const yjs = yUpdateFor("just body");
    const bytes = encodeLiveSectionsUpdate({ yjs_update: yjs });
    expect(bytes[0]).toBe(MSG_LIVE_SECTIONS_UPDATE);
    const frame = decodeLiveSectionsUpdate(decodeMessage(bytes)!.payload);
    expect(frame.state).toBeUndefined();
    expect(frame.yjs_update).toBeDefined();
    expect(Array.from(frame.yjs_update!)).toEqual(Array.from(yjs));
  });

  it("state-only update carries state and no yjs_update (lock/pending-only change)", () => {
    const frame = decodeLiveSectionsUpdate(
      decodeMessage(encodeLiveSectionsUpdate({ state: STATE }))!.payload,
    );
    expect(frame.state).toEqual(STATE);
    expect(frame.yjs_update).toBeUndefined();
  });

  it("distinguishes an empty (zero-length) yjs_update from an absent one", () => {
    const withEmpty = decodeLiveSectionsUpdate(
      decodeMessage(encodeLiveSectionsUpdate({ yjs_update: new Uint8Array(0) }))!.payload,
    );
    expect(withEmpty.yjs_update).toBeDefined();
    expect(withEmpty.yjs_update!.length).toBe(0);

    const withNone = decodeLiveSectionsUpdate(
      decodeMessage(encodeLiveSectionsUpdate({ state: STATE }))!.payload,
    );
    expect(withNone.yjs_update).toBeUndefined();
  });

  it("fails loud on a malformed state header", () => {
    // Hand-build a bootstrap frame whose JSON state omits publish_pause_join_mirror.
    const badHeader = JSON.stringify({
      doc_session_id: "s",
      state: { topology: [], blocked_section_ids: [], pending_sections: [] },
    });
    const json = new TextEncoder().encode(badHeader);
    const payload = new Uint8Array(4 + json.length);
    payload[0] = (json.length >>> 24) & 0xff;
    payload[1] = (json.length >>> 16) & 0xff;
    payload[2] = (json.length >>> 8) & 0xff;
    payload[3] = json.length & 0xff;
    payload.set(json, 4);
    expect(() => decodeLiveSectionsBootstrap(payload)).toThrow(/publish_pause_join_mirror/);
  });
});
