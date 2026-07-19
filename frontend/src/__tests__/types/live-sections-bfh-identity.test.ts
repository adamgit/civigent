/**
 * Synthetic BFH identity: reserved constant, never per-instance, never re-keyed.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import {
  SectionId,
  BEFORE_FIRST_HEADING_SECTION_ID,
  syntheticBeforeFirstHeadingSeed,
} from "../../types/live-sections";
import { BEFORE_FIRST_HEADING_KEY } from "../../pages/document-page-utils";
import { createLiveSectionReplica } from "../../services/live-section-replica";
import type { WireLiveSectionsState } from "../../types/shared";

const HEADED = "section::alpha";

describe("synthetic BFH identity", () => {
  it("brands from the reserved key to the reserved constant, stable across calls", () => {
    expect(SectionId.text(BEFORE_FIRST_HEADING_SECTION_ID)).toBe(BEFORE_FIRST_HEADING_KEY);
    expect(SectionId.brand(BEFORE_FIRST_HEADING_KEY)).toBe(BEFORE_FIRST_HEADING_SECTION_ID);
    // Not per-instance — every brand of the same key is the same value.
    expect(SectionId.brand(BEFORE_FIRST_HEADING_KEY)).toBe(SectionId.brand(BEFORE_FIRST_HEADING_KEY));
  });

  it("the synthetic BFH seed uses the reserved constant and no body", () => {
    const seed = syntheticBeforeFirstHeadingSeed();
    expect(seed.ref.id).toBe(BEFORE_FIRST_HEADING_SECTION_ID);
    expect(seed.ref.headingPath).toEqual([]);
    expect(seed.markdown).toBe("");
  });

  it("root-split creates a NEW headed id and dissolves BFH — never re-keys BFH", () => {
    // Bootstrap: empty doc with only the synthetic BFH fragment present (a real
    // BFH always carries at least an empty paragraph, so it registers in `share`).
    const bfhDoc = new Y.Doc();
    bfhDoc.transact(() =>
      updateYFragment(bfhDoc, bfhDoc.getXmlFragment(BEFORE_FIRST_HEADING_KEY), markdownToProseMirrorNode("seed"), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
    const replica = createLiveSectionReplica();
    const bfhState: WireLiveSectionsState = {
      topology: [{ fragment_key: BEFORE_FIRST_HEADING_KEY, heading_path: [] }],
      blocked_section_ids: [],
      pending_sections: [],
      publish_pause_join_mirror: "not_in_pause",
    };
    replica.bindToDocSession({ docSessionId: "s", state: bfhState, yjsUpdate: Y.encodeStateAsUpdate(bfhDoc) });
    expect(replica.getLiveSection(BEFORE_FIRST_HEADING_SECTION_ID)).toBeDefined();

    // Root-split: a new headed fragment materializes; BFH leaves topology.
    const splitDoc = new Y.Doc();
    const frag = splitDoc.getXmlFragment(HEADED);
    splitDoc.transact(() =>
      updateYFragment(splitDoc, frag, markdownToProseMirrorNode("# Alpha\n\nbody"), { mapping: new Map(), isOMark: new Map() }),
    );
    replica.ingestUpdate({
      yjsUpdate: Y.encodeStateAsUpdate(splitDoc),
      state: { ...bfhState, topology: [{ fragment_key: HEADED, heading_path: ["Alpha"] }] },
    });

    // BFH is gone; the heading is a NEW id, not the BFH constant re-keyed.
    expect(replica.findInTopology(BEFORE_FIRST_HEADING_SECTION_ID)).toBeUndefined();
    const headed = replica.getLiveSection(SectionId.brand(HEADED));
    expect(headed).toBeDefined();
    expect(SectionId.text(headed!.id)).toBe(HEADED);
    expect(SectionId.text(headed!.id)).not.toBe(BEFORE_FIRST_HEADING_KEY);
  });
});
