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
 *   F3 — the fragment stays the display authority AFTER bootstrap: an update
 *        frame's content is what the next paint shows, so the replica is a live
 *        view of the Y.Doc and never a snapshot taken at first read.
 *   F4 — an update frame that changes the doc notifies subscribers, including a
 *        delete-only frame (the shape that arrives when another writer or the
 *        server removes content).
 *   F5 — a section whose first read finds it empty is not frozen at empty: a
 *        later frame's content is what the next paint shows.
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

function clearFragment(doc: Y.Doc, key: string): void {
  const frag = doc.getXmlFragment(key);
  doc.transact(() => {
    while (frag.length > 0) frag.delete(0, 1);
  });
}

function betaTopologyState(): WireLiveSectionsState {
  return {
    topology: [{ fragment_key: BETA, heading_path: ["Beta"], heading_level: 1 }],
    blocked_section_ids: [],
    pending_sections: [],
    publish_pause_join_mirror: "not_in_pause",
  };
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

  it("F3: paintMarkdown shows the update frame's content, not the content at first read", () => {
    const doc = new Y.Doc();
    writeFragment(doc, BETA, "Beta");
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: betaTopologyState(),
      yjsUpdate: Y.encodeStateAsUpdate(doc),
    });

    // Reading BEFORE the update is load-bearing: this first read is what any
    // per-fragment memoization populates. Drop it and the test passes vacuously.
    expect(replica.getLiveSection(SectionId.brand(BETA)).readMarkdown()).toContain("Beta");

    // The frame must not introduce a NEW fragment key: a `Y.Doc.share` size
    // change is enough to rebuild an identity-keyed invalidation map and hide a
    // broken one. A body-only edit to a live section is the ordinary case.
    const beforeEdit = Y.encodeStateVector(doc);
    writeFragment(doc, BETA, "Beta edited");
    replica.ingestUpdate({ yjsUpdate: Y.encodeStateAsUpdate(doc, beforeEdit) });

    expect(replica.getLiveSection(SectionId.brand(BETA)).readMarkdown()).toContain("edited");
  });

  it("F4: a delete-only update frame notifies subscribers", () => {
    const doc = new Y.Doc();
    writeFragment(doc, BETA, "Beta");
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: betaTopologyState(),
      yjsUpdate: Y.encodeStateAsUpdate(doc),
    });

    let notified = 0;
    replica.subscribe(() => { notified += 1; });

    // A Yjs deletion creates no new structs, so the doc's state vector is
    // IDENTICAL before and after — it cannot stand in for "did anything change".
    const beforeClear = Y.encodeStateVector(doc);
    clearFragment(doc, BETA);
    replica.ingestUpdate({ yjsUpdate: Y.encodeStateAsUpdate(doc, beforeClear) });

    expect(notified).toBeGreaterThan(0);
  });

  it("F5: a section first read while empty shows the content a later frame delivers", () => {
    const doc = new Y.Doc();
    writeFragment(doc, BETA, "Beta");
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: betaTopologyState(),
      yjsUpdate: Y.encodeStateAsUpdate(doc),
    });

    const beforeClear = Y.encodeStateVector(doc);
    clearFragment(doc, BETA);
    replica.ingestUpdate({ yjsUpdate: Y.encodeStateAsUpdate(doc, beforeClear) });

    // Reading here is load-bearing: it is the read that captures "" as this
    // fragment's answer. The section is legitimately empty at this instant.
    expect(replica.getLiveSection(SectionId.brand(BETA)).readMarkdown().trim()).toBe("");

    const beforeRefill = Y.encodeStateVector(doc);
    writeFragment(doc, BETA, "Beta returns");
    replica.ingestUpdate({ yjsUpdate: Y.encodeStateAsUpdate(doc, beforeRefill) });

    expect(replica.getLiveSection(SectionId.brand(BETA)).readMarkdown()).toContain("returns");
  });
});
