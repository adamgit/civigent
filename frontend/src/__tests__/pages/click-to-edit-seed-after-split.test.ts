/**
 * Click-to-edit-after-split MUST NOT let a poisoned cold seed paint over live text.
 *
 * The old dual-authority bug: after a consecutive-H1 split, the survivor kept its
 * pre-split multi-H1 `content` seed, and display fell back to that seed (via the
 * retired `displaySectionMarkdown(section, store)` understudy) until sync — painting
 * duplicate headings.
 *
 * The redesign retires the store-backed display understudy entirely: the single
 * display authority is `useLiveSectionReplica().paintMarkdown(id, seed)` — the live
 * fragment (`getLiveSection(id).readMarkdown()`) once the replica has an
 * authoritative bootstrap, the cold seed ONLY while not bootstrapped. Once ready,
 * painting an id that is not in the live topology is a CALLER BUG and throws —
 * returning the seed there would resurrect pre-live REST text for a section a
 * split/merge/delete already removed. The local `paint()` helper below mirrors
 * that hook logic exactly.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import { createLiveSectionReplica } from "../../services/live-section-replica";
import { SectionId } from "../../types/live-sections";
import type { WireLiveSectionsState } from "../../types/shared";

const SEC_1 = "section::sec_heading_1";
const SEC_2 = "section::sec_heading_2";
const MULTI_H1 = "# heading 1\n\n# heading 2\n\n# heading 3\n";

function writeFragment(doc: Y.Doc, key: string, markdown: string): void {
  const frag = doc.getXmlFragment(key);
  const node = markdownToProseMirrorNode(markdown);
  doc.transact(() => updateYFragment(doc, frag, node, { mapping: new Map(), isOMark: new Map() }));
}

/**
 * The redesign display authority, exactly as `useLiveSectionReplica().paintMarkdown`
 * implements it: cold seed only while not bootstrapped; live fragment once
 * bootstrapped + in topology; ready + off-topology throws (seed resurrection is
 * illegal after live authority exists). Never the store-backed understudy (retired).
 */
function paint(
  replica: ReturnType<typeof createLiveSectionReplica>,
  id: SectionId,
  seed: string,
): string {
  if (!replica.isCurrentlyLiveAuthority) return seed;
  // getLiveSection throws for an off-topology id — seed resurrection is illegal.
  return replica.getLiveSection(id).readMarkdown();
}

/** A bootstrap doc carrying the CORRECT post-split fragments. */
function postSplitUpdate(): Uint8Array {
  const doc = new Y.Doc();
  writeFragment(doc, SEC_1, "# heading 1\n\nsurvivor body");
  writeFragment(doc, SEC_2, "# heading 2\n\nsecond body");
  return Y.encodeStateAsUpdate(doc);
}

function state(): WireLiveSectionsState {
  return {
    topology: [
      { fragment_key: SEC_1, heading_path: ["heading 1"] },
      { fragment_key: SEC_2, heading_path: ["heading 2"] },
    ],
    blocked_section_ids: [],
    pending_sections: [],
    publish_pause_join_mirror: "not_in_pause",
  };
}

describe("click-to-edit after consecutive-H1 split: the poisoned seed cannot paint", () => {
  it("paints the survivor's live fragment, NOT the poisoned multi-H1 seed", () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({ docSessionId: "s", state: state(), yjsUpdate: postSplitUpdate() });

    // Paint the survivor with the POISONED pre-split seed passed as the cold seed:
    // once bootstrapped the seed is ignored and the live fragment wins.
    const paintedSurvivor = paint(replica, SectionId.brand(SEC_1), MULTI_H1);
    const paintedHeading2 = paint(replica, SectionId.brand(SEC_2), "# heading 2\n");

    // The survivor paints ITS fragment only — the poisoned seed's extra H1s are gone.
    expect(paintedSurvivor).toContain("# heading 1");
    expect(paintedSurvivor).not.toContain("# heading 2");
    expect(paintedSurvivor).not.toContain("# heading 3");
    // The neighbour paints its own fragment.
    expect(paintedHeading2).toContain("# heading 2");
    expect(paintedHeading2).not.toContain("# heading 1");
  });

  it("off-topology after ready THROWS — the cold seed is never resurrected", () => {
    // Bootstrap with ONLY the survivor in topology; painting a removed/unknown
    // key once live authority exists is a caller bug and must fail loud, not
    // silently paint pre-live REST text.
    const doc = new Y.Doc();
    writeFragment(doc, SEC_1, "# heading 1\n\nsurvivor body");
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: {
        topology: [{ fragment_key: SEC_1, heading_path: ["heading 1"] }],
        blocked_section_ids: [],
        pending_sections: [],
        publish_pause_join_mirror: "not_in_pause",
      },
      yjsUpdate: Y.encodeStateAsUpdate(doc),
    });

    // SEC_1 is live → fragment wins over the poisoned seed.
    expect(paint(replica, SectionId.brand(SEC_1), MULTI_H1)).not.toContain("# heading 2");
    // SEC_2 is NOT in topology → painting it is illegal after ready; the seed
    // must NOT come back.
    expect(() => paint(replica, SectionId.brand(SEC_2), "# heading 2\n")).toThrow(
      /not in the live topology/,
    );
  });

  it("before any bootstrap (cold) the seed is the only available paint", () => {
    // Pre-live / no-session: the replica is not authoritative, so paint the seed verbatim.
    const replica = createLiveSectionReplica();
    expect(replica.isCurrentlyLiveAuthority).toBe(false);
    expect(paint(replica, SectionId.brand(SEC_1), "# heading 1\n")).toBe("# heading 1\n");
  });
});
