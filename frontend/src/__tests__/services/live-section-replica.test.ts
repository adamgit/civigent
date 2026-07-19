/**
 * LiveSectionReplica public-API contract (frontend live-document design).
 *
 * Feeds the replica decoded frames directly (transport-agnostic) and asserts:
 *   - not currently live authority before a bind; authority only after atomic apply;
 *   - getTopology / findInTopology + getLiveSection authority gate + handle methods;
 *   - per-section editability (setEditingEnabled + blocked + publish pause);
 *   - update frames (content-only / state-only / structural) ingest and notify.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import { createLiveSectionReplica, unwrapLiveEditorBindingForMilkdown } from "../../services/live-section-replica";
import { SectionId } from "../../types/live-sections";
import type { WireLiveSectionsState } from "../../types/shared";

const ALPHA = "section::alpha";
const BETA = "section::beta";

function writeFragment(doc: Y.Doc, key: string, markdown: string): void {
  const frag = doc.getXmlFragment(key);
  const node = markdownToProseMirrorNode(markdown);
  doc.transact(() => updateYFragment(doc, frag, node, { mapping: new Map(), isOMark: new Map() }));
}

/** Build a source doc with two fragments and return its full update. */
function seedDocUpdate(): Uint8Array {
  const doc = new Y.Doc();
  writeFragment(doc, ALPHA, "# Alpha\n\nAlpha body");
  writeFragment(doc, BETA, "## Beta\n\nBeta body");
  return Y.encodeStateAsUpdate(doc);
}

function state(overrides: Partial<WireLiveSectionsState> = {}): WireLiveSectionsState {
  return {
    topology: [
      { fragment_key: ALPHA, heading_path: ["Alpha"] },
      { fragment_key: BETA, heading_path: ["Alpha", "Beta"] },
    ],
    blocked_section_ids: [],
    pending_sections: [],
    publish_pause_join_mirror: "not_in_pause",
    ...overrides,
  };
}

describe("LiveSectionReplica", () => {
  it("is not ready and has no topology before a bootstrap", () => {
    const replica = createLiveSectionReplica();
    expect(replica.isCurrentlyLiveAuthority).toBe(false);
    expect(replica.getTopology()).toEqual([]);
    expect(replica.findInTopology(SectionId.brand(ALPHA))).toBeUndefined();
  });

  it("becomes ready after an atomic bootstrap with all fragments present", () => {
    const replica = createLiveSectionReplica();
    let notifications = 0;
    replica.subscribe(() => {
      notifications++;
      // Every notification observes a fully-applied frame: ready + topology set.
      expect(replica.isCurrentlyLiveAuthority).toBe(true);
      expect(replica.getTopology()).toHaveLength(2);
    });

    replica.bindToDocSession({ docSessionId: "sess-1", state: state(), yjsUpdate: seedDocUpdate() });

    expect(replica.isCurrentlyLiveAuthority).toBe(true);
    expect(notifications).toBe(1);
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, BETA]);
    expect(replica.getTopology()[1].headingPath).toEqual(["Alpha", "Beta"]);
  });

  it("gates getLiveSection on topology membership and reads markdown from the fragment", () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });

    const alpha = replica.getLiveSection(SectionId.brand(ALPHA));
    expect(alpha).toBeDefined();
    expect(alpha!.readMarkdown()).toContain("Alpha body");
    expect(replica.findInTopology(SectionId.brand("section::ghost"))).toBeUndefined();
  });

  it("editability requires enableEditing and respects blocked + publish pause", async () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: state({ blocked_section_ids: [BETA] }),
      yjsUpdate: seedDocUpdate(),
    });

    // Observer mode: nothing editable.
    expect(replica.getLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);

    replica.setEditingEnabled(true);
    expect(replica.getLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(true);
    // Beta is blocked → not editable even with editing enabled.
    expect(replica.getLiveSection(SectionId.brand(BETA))!.isEditable()).toBe(false);

    // A publish pause makes everything non-editable.
    replica.ingestUpdate({ state: state({ publish_pause_join_mirror: "pause_active_editors_frozen" }) });
    expect(replica.getLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);

    replica.setEditingEnabled(false);
    replica.ingestUpdate({ state: state() });
    expect(replica.getLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);
  });

  it("isPending reports presence-only pending state (boolean), gated on topology membership", () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({
      docSessionId: "s",
      state: state({
        pending_sections: [{ fragment_key: ALPHA, writer_id: "w1", writer_display_name: "Writer One" }],
      }),
      yjsUpdate: seedDocUpdate(),
    });

    // Alpha has a live pending-writer session → pending; Beta does not.
    expect(replica.isPending(SectionId.brand(ALPHA))).toBe(true);
    expect(replica.isPending(SectionId.brand(BETA))).toBe(false);
    // An id not in topology never reports pending.
    expect(replica.isPending(SectionId.brand("section::ghost"))).toBe(false);

    // A state-only update that clears pending drops the flag (idempotent full state).
    replica.ingestUpdate({ state: state() });
    expect(replica.isPending(SectionId.brand(ALPHA))).toBe(false);
  });

  it("createEditorBinding returns an opaque binding whose attach fields resolve to exactly that fragment", () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });
    const binding = replica.getLiveSection(SectionId.brand(ALPHA))!.createEditorBinding();
    // The public type carries no fields — the editor boundary resolves them.
    const attach = unwrapLiveEditorBindingForMilkdown(binding);
    expect(attach.fragmentKey).toBe(ALPHA);
    expect(attach.doc).toBeInstanceOf(Y.Doc);
    expect(attach.awareness).toBeDefined();
  });

  it("a state-only update frame drops a merged-away section from topology", () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });

    replica.ingestUpdate({ state: state({ topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"] }] }) });
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA]);
    expect(replica.findInTopology(SectionId.brand(BETA))).toBeUndefined();
  });

  it("COLD-START: an update frame before any bootstrap leaves the replica not-ready and nothing default-editable", () => {
    // A topology/lock change that races ahead of the bootstrap must NOT flip the
    // replica to ready — the client can only become ready from an actor-captured
    // bootstrap. Consumers gate on `isCurrentlyLiveAuthority` (paint seeds until then), and nothing is
    // editable without an explicit `enableEditing`, so no default-editable state
    // can leak from a stray pre-bootstrap frame.
    const replica = createLiveSectionReplica();
    replica.ingestUpdate({ state: state() });
    expect(replica.isCurrentlyLiveAuthority).toBe(false);
    // Membership may resolve from the stray frame's topology, but it is never editable
    // without an explicit enableEditing — and membership is NOT authoritative access.
    const alpha = replica.findInTopology(SectionId.brand(ALPHA));
    if (alpha) expect(alpha.isEditable()).toBe(false);
    // The authoritative-access gate must refuse the cold path: getLiveSection throws
    // until a bind lands, so no default-editable / stale-topology live access leaks.
    expect(() => replica.getLiveSection(SectionId.brand(ALPHA))).toThrow(/not currently live authority/);
  });

  it("RECONNECT (same session): a fresh complete bootstrap replaces prior state wholesale — exact content, no duplication", () => {
    // The reconnect bootstrap comes from the SAME surviving DocSession, so the
    // server doc's Yjs history is a superset of what the first bootstrap carried
    // and merging it is exact. (A bootstrap from a DIFFERENT session has a
    // disjoint history and is refused — see the SESSION-END test.)
    const serverDoc = new Y.Doc();
    writeFragment(serverDoc, ALPHA, "# Alpha\n\nAlpha body");
    writeFragment(serverDoc, BETA, "## Beta\n\nBeta body");

    const replica = createLiveSectionReplica();
    replica.bindToDocSession({ docSessionId: "sess-1", state: state(), yjsUpdate: Y.encodeStateAsUpdate(serverDoc) });
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, BETA]);

    // While the socket was down, the session edited Alpha, merged Beta away and
    // grew a new Gamma. The reconnect delivers the session's full evolved state.
    const GAMMA = "section::gamma";
    writeFragment(serverDoc, ALPHA, "# Alpha\n\nAlpha reconnected");
    writeFragment(serverDoc, GAMMA, "## Gamma\n\nGamma body");
    replica.mergeSameSessionBootstrap({
      docSessionId: "sess-1",
      state: state({
        topology: [
          { fragment_key: ALPHA, heading_path: ["Alpha"] },
          { fragment_key: GAMMA, heading_path: ["Alpha", "Gamma"] },
        ],
      }),
      yjsUpdate: Y.encodeStateAsUpdate(serverDoc),
    });
    serverDoc.destroy();

    expect(replica.isCurrentlyLiveAuthority).toBe(true);
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, GAMMA]);
    expect(replica.findInTopology(SectionId.brand(BETA))).toBeUndefined();
    expect(replica.getLiveSection(SectionId.brand(GAMMA))!.readMarkdown()).toContain("Gamma body");
    // Exactness: the evolved body fully replaced the original — nothing doubled.
    const alpha = replica.getLiveSection(SectionId.brand(ALPHA))!.readMarkdown();
    expect(alpha).toContain("Alpha reconnected");
    expect(alpha).not.toContain("Alpha body");
  });

});

/**
 * Target-contract canaries for live-section-replica-api-renames.md.
 * Written against the post-rename API so they fail until that work lands.
 * Do not expand into a matrix — these three lock the invariants that matter.
 */
describe("LiveSectionReplica target-contract canaries", () => {
  it("bindToDocSession / mergeSameSessionBootstrap each enforce a single precondition", () => {
    const replica = createLiveSectionReplica();
    const bootstrap = { docSessionId: "sess-1", state: state(), yjsUpdate: seedDocUpdate() };

    expect(() => replica.mergeSameSessionBootstrap(bootstrap)).toThrow(/not bound/);
    replica.bindToDocSession(bootstrap);
    expect(() => replica.bindToDocSession(bootstrap)).toThrow(/already bound/);
  });

  it("getLiveSection throws for an off-topology id while currently live", () => {
    const replica = createLiveSectionReplica();
    replica.bindToDocSession({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });
    expect(() => replica.getLiveSection(SectionId.brand("section::ghost"))).toThrow();
  });
});
