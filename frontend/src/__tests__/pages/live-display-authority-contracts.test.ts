/**
 * Live display authority contracts (redesign).
 *
 *   F1 — the single display authority is the live fragment via
 *        `LiveSectionReplica.requireLiveSection(id).readMarkdown()`: once the replica
 *        is bootstrapped, a section's body IS the fragment, never the reconstructed
 *        `# Heading` seed carried on the row `.content`.
 *   F2 — `adoptFreshSectionLayout` (the legacy identity/order op) must not install a
 *        reconstructed `# Heading` from a layout payload onto an already-live section;
 *        it keeps `prev.content` as an inert cold seed (never live display authority).
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import {
  adoptFreshSectionLayout,
  type DocumentSection,
} from "../../pages/document-page-utils";
import { createLiveSectionReplica } from "../../services/live-section-replica";
import { SectionId } from "../../types/live-sections";
import type { WireLiveSectionsState } from "../../types/shared";

const BETA = "section::sec_beta";

function writeFragment(doc: Y.Doc, key: string, markdown: string): void {
  const frag = doc.getXmlFragment(key);
  const node = markdownToProseMirrorNode(markdown);
  doc.transact(() => updateYFragment(doc, frag, node, { mapping: new Map(), isOMark: new Map() }));
}

function section(partial: {
  heading: string;
  heading_path: string[];
  fragment_key: string;
  content?: string;
}): DocumentSection {
  return {
    heading: partial.heading,
    heading_path: partial.heading_path,
    depth: partial.heading_path.length,
    content: partial.content ?? "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
    section_length_warning: false,
    word_count: 0,
    fragment_key: partial.fragment_key,
    section_file: `${partial.fragment_key.replace(/^section::/, "")}.md`,
  };
}

describe("live display authority contracts", () => {
  it("F1: once bootstrapped, paintMarkdown shows the demoted fragment — not the reconstructed row seed", () => {
    // The live fragment is the demoted body "Beta" (no heading); the row seed is a
    // stale reconstructed "# Beta\n\nBeta" from a skeleton prepend.
    const doc = new Y.Doc();
    writeFragment(doc, BETA, "Beta");
    const replica = createLiveSectionReplica();
    const state: WireLiveSectionsState = {
      topology: [{ fragment_key: BETA, heading_path: ["Beta"] }],
      blocked_section_ids: [],
      pending_sections: [],
      publish_pause_join_mirror: "not_in_pause",
    };
    replica.applyBootstrap({ docSessionId: "s", state, yjsUpdate: Y.encodeStateAsUpdate(doc) });

    // The display body IS the live fragment — the reconstructed row seed is irrelevant.
    const painted = replica.requireLiveSection(SectionId.brand(BETA))!.readMarkdown();
    expect(painted).toContain("Beta");
    expect(painted).not.toMatch(/^#\s/m);
  });

  it("F2: layout adoption must not install reconstructed heading content onto an already-live section", () => {
    const prev = [
      section({
        heading: "Beta",
        heading_path: ["Beta"],
        fragment_key: BETA,
        // Client already holds demoted body (or would, if it tracked the fragment).
        content: "Beta",
      }),
    ];
    const fresh = [
      section({
        heading: "Beta",
        heading_path: ["Beta"],
        fragment_key: BETA,
        // Server layout/workspace payload still invents the H1 via prependHeadings.
        content: "# Beta\n\nBeta",
      }),
    ];

    // Existing live key: adopt must keep prev.content as an inert cold seed, never
    // install the reconstructed fresh.content, regardless of mount state.
    const next = adoptFreshSectionLayout({
      prev,
      fresh,
      focusedSectionIndexRef: { current: null },
    });

    expect(next[0].content).toBe("Beta");
    expect(next[0].content).not.toMatch(/^#\s/m);
  });
});
