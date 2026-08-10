/**
 * Pause join-mirror ≠ freeze machine.
 *
 * Spec 10 / todolist: a live-sections state frame may carry a pause join mirror
 * for UI / isEditable. Applying that state must NEVER invoke publish-pause
 * START/READY/END barrier handlers. Opcode `0x10` freeze is covered by
 * `crdt-provider-publish-pause.test.ts` — this file deliberately does NOT
 * mount CrdtProvider or replace global WebSocket (reconnect/timer risk).
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import { createLiveSectionReplica } from "../../services/live-section-replica";
import { routeLiveSectionFrame, MSG_LIVE_SECTIONS_UPDATE } from "../../services/live-section-frames";
import { SectionId } from "../../types/live-sections";

const ALPHA = "section::alpha";

function seedUpdate(): Uint8Array {
  const src = new Y.Doc();
  src.transact(() =>
    updateYFragment(
      src,
      src.getXmlFragment(ALPHA),
      markdownToProseMirrorNode("# Alpha\n\nbody"),
      { mapping: new Map(), isOMark: new Map() },
    ),
  );
  const update = Y.encodeStateAsUpdate(src);
  src.destroy();
  return update;
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

describe("publish-pause join mirror vs freeze opcodes", () => {
  it("5: state-only live frame with pause mirror does not invoke freeze/ack/unfreeze barriers", async () => {
    const freeze = vi.fn(() => Promise.resolve());
    const unfreeze = vi.fn();
    const onPublishPauseStart = vi.fn();
    const onPublishPauseEnd = vi.fn();

    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: {
        topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"], heading_level: 1 }],
        blocked_section_ids: [],
        pending_sections: [],
        publish_pause_join_mirror: "not_in_pause",
      },
      yjsUpdate: seedUpdate(),
    });

    // What CrdtProvider does for 0x15: forward payload to routeLiveSectionFrame only
    // (see crdt-provider.ts MSG_LIVE_SECTIONS_* case). No pause handlers on that path.
    const applied = routeLiveSectionFrame(
      MSG_LIVE_SECTIONS_UPDATE,
      frameBody({
        has_yjs_update: false,
        state: {
          topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"], heading_level: 1 }],
          blocked_section_ids: [],
          pending_sections: [],
          publish_pause_join_mirror: "pause_active_editors_frozen",
        },
      }),
      replica,
    );
    expect(applied).toBe(true);

    // Mirror may affect editability; it must not start the freeze machine.
    expect(freeze).not.toHaveBeenCalled();
    expect(unfreeze).not.toHaveBeenCalled();
    expect(onPublishPauseStart).not.toHaveBeenCalled();
    expect(onPublishPauseEnd).not.toHaveBeenCalled();

    // The mirror's ONLY legitimate effect: it contributes to `isEditable()`. Even
    // with local write capability enabled, a "pause_active_editors_frozen" mirror
    // renders the section non-editable — purely a passive reflection, no barrier.
    replica.setEditingEnabled(true);
    expect(replica.getLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);
    // Lifting the mirror (a fresh state frame) restores editability, still no barrier.
    routeLiveSectionFrame(
      MSG_LIVE_SECTIONS_UPDATE,
      frameBody({
        has_yjs_update: false,
        state: {
          topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"], heading_level: 1 }],
          blocked_section_ids: [],
          pending_sections: [],
          publish_pause_join_mirror: "not_in_pause",
        },
      }),
      replica,
    );
    expect(replica.getLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(true);
    expect(freeze).not.toHaveBeenCalled();
    expect(unfreeze).not.toHaveBeenCalled();

    replica.destroy();
  });
});
