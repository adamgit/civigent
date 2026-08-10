/**
 * Test helper: build a `MSG_LIVE_SECTIONS_BOOTSTRAP` frame payload (opcode
 * already stripped) so page tests can make the page's LiveSectionReplica
 * currently live authority. The mount gate requires a real binding from
 * `getLiveSection(...).createEditorBinding()`, which only exists once a
 * bootstrap has bound the replica — cold pages never mount live editors.
 */

import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import type { WireLiveSectionsState, HeadingLevel } from "../../types/shared";

export const MSG_LIVE_SECTIONS_BOOTSTRAP_OPCODE = 0x14;

export interface LiveBootstrapSectionFixture {
  fragmentKey: string;
  headingPath: string[];
  headingLevel: HeadingLevel;
  markdown: string;
}

/** Encode `[json_len:uint32 BE][json][yjs_update]` (backend codec mirror). */
export function encodeLiveFrameBody(header: unknown, trailing: Uint8Array): Uint8Array {
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

/** Build a bootstrap frame payload for the given sections (fresh server doc). */
export function liveBootstrapFrame(
  docSessionId: string,
  sections: LiveBootstrapSectionFixture[],
): Uint8Array {
  const src = new Y.Doc();
  for (const s of sections) {
    const frag = src.getXmlFragment(s.fragmentKey);
    src.transact(() =>
      updateYFragment(src, frag, markdownToProseMirrorNode(s.markdown), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
  }
  const state: WireLiveSectionsState = {
    topology: sections.map((s) => ({ fragment_key: s.fragmentKey, heading_path: s.headingPath, heading_level: s.headingLevel })),
    blocked_section_ids: [],
    pending_sections: [],
    publish_pause_join_mirror: "not_in_pause",
  };
  const update = Y.encodeStateAsUpdate(src);
  src.destroy();
  return encodeLiveFrameBody({ doc_session_id: docSessionId, state }, update);
}
