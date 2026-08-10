/**
 * Live display authority contracts (redesign).
 *
 *   F1 — the single display authority is the live fragment via
 *        `LiveSectionReplica.getLiveSection(id).readMarkdown()`: once the replica
 *        is bootstrapped, a section's body IS the fragment, never the reconstructed
 *        `# Heading` seed carried on the row `.content`.
 *   F2 — render rows are BODY-FREE identity (`RenderSectionRef`): no layout or
 *        REST payload can install reconstructed `# Heading` text onto a live row,
 *        because the row cannot carry body/metadata fields at all (the legacy
 *        `adoptFreshSectionLayout` content-preserve dance is deleted with it).
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import type { WorkspaceSectionDto } from "../../pages/document-page-utils";
import { dtoToRenderRef } from "../../pages/cold-bootstrap";
import { createLiveSectionReplica } from "../../services/live-section-replica";
import { SectionId } from "../../types/live-sections";
import type { WireLiveSectionsState } from "../../types/shared";
import { HeadingLevel } from "../../types/shared";

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
}): WorkspaceSectionDto {
  return {
    heading: partial.heading,
    heading_path: partial.heading_path,
    heading_level: HeadingLevel.parse(partial.heading_path.length === 0 ? 0 : 1),
    content: partial.content ?? "",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: true,
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
      topology: [{ fragment_key: BETA, heading_path: ["Beta"], heading_level: 1 }],
      blocked_section_ids: [],
      pending_sections: [],
      publish_pause_join_mirror: "not_in_pause",
    };
    replica.bindToDocSession({ docSessionId: "s", state, yjsUpdate: Y.encodeStateAsUpdate(doc) });

    // The display body IS the live fragment — the reconstructed row seed is irrelevant.
    const painted = replica.getLiveSection(SectionId.brand(BETA))!.readMarkdown();
    expect(painted).toContain("Beta");
    expect(painted).not.toMatch(/^#\s/m);
  });

  it("F2: render rows are body-free — a REST payload cannot ride content onto render identity", () => {
    const dto = section({
      heading: "Beta",
      heading_path: ["Beta"],
      fragment_key: BETA,
      // Server workspace payload still invents the H1 via prependHeadings; the
      // render row must not carry it (or any body/metadata field) at all.
      content: "# Beta\n\nBeta",
    });

    const ref = dtoToRenderRef(dto);
    expect(Object.keys(ref).sort()).toEqual(["headingLevel", "headingPath", "id"]);
    expect(SectionId.text(ref.id)).toBe(BETA);
    expect([...ref.headingPath]).toEqual(["Beta"]);
  });
});
