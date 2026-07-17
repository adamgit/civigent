/**
 * LiveSectionReplica public-API contract (frontend live-document design).
 *
 * Feeds the replica decoded frames directly (transport-agnostic) and asserts:
 *   - not ready before a bootstrap; ready only after atomic apply;
 *   - getTopology / lookupInTopology + requireLiveSection membership gate + handle methods;
 *   - per-section editability (enableEditing + blocked + publish pause);
 *   - update frames (content-only / state-only / structural) apply and notify.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { updateYFragment } from "y-prosemirror";
import { markdownToProseMirrorNode } from "@ks/milkdown-serializer";
import { createLiveSectionReplica } from "../../services/live-section-replica";
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
    expect(replica.hasAuthoritativeBootstrap).toBe(false);
    expect(replica.getTopology()).toEqual([]);
    expect(replica.lookupInTopology(SectionId.brand(ALPHA))).toBeUndefined();
  });

  it("becomes ready after an atomic bootstrap with all fragments present", () => {
    const replica = createLiveSectionReplica();
    let notifications = 0;
    replica.subscribe(() => {
      notifications++;
      // Every notification observes a fully-applied frame: ready + topology set.
      expect(replica.hasAuthoritativeBootstrap).toBe(true);
      expect(replica.getTopology()).toHaveLength(2);
    });

    replica.applyBootstrap({ docSessionId: "sess-1", state: state(), yjsUpdate: seedDocUpdate() });

    expect(replica.hasAuthoritativeBootstrap).toBe(true);
    expect(notifications).toBe(1);
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, BETA]);
    expect(replica.getTopology()[1].headingPath).toEqual(["Alpha", "Beta"]);
  });

  it("gates requireLiveSection on topology membership and reads markdown from the fragment", () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });

    const alpha = replica.requireLiveSection(SectionId.brand(ALPHA));
    expect(alpha).toBeDefined();
    expect(alpha!.readMarkdown()).toContain("Alpha body");
    expect(replica.requireLiveSection(SectionId.brand("section::ghost"))).toBeUndefined();
  });

  it("editability requires enableEditing and respects blocked + publish pause", async () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({
      docSessionId: "s",
      state: state({ blocked_section_ids: [BETA] }),
      yjsUpdate: seedDocUpdate(),
    });

    // Observer mode: nothing editable.
    expect(replica.requireLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);

    replica.setLocalWriteCapability(true);
    expect(replica.requireLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(true);
    // Beta is blocked → not editable even with editing enabled.
    expect(replica.requireLiveSection(SectionId.brand(BETA))!.isEditable()).toBe(false);

    // A publish pause makes everything non-editable.
    replica.applyUpdate({ state: state({ publish_pause_join_mirror: "pause_active_editors_frozen" }) });
    expect(replica.requireLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);

    replica.setLocalWriteCapability(false);
    replica.applyUpdate({ state: state() });
    expect(replica.requireLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);
  });

  it("isPending reports presence-only pending state (boolean), gated on topology membership", () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({
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
    replica.applyUpdate({ state: state() });
    expect(replica.isPending(SectionId.brand(ALPHA))).toBe(false);
  });

  it("createEditorBinding returns an opaque binding for exactly that fragment", () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });
    const binding = replica.requireLiveSection(SectionId.brand(ALPHA))!.createEditorBinding();
    expect(binding.fragmentKey).toBe(ALPHA);
    expect(binding.doc).toBeInstanceOf(Y.Doc);
    expect(binding.awareness).toBeDefined();
  });

  it("a state-only update frame drops a merged-away section from topology", () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({ docSessionId: "s", state: state(), yjsUpdate: seedDocUpdate() });

    replica.applyUpdate({ state: state({ topology: [{ fragment_key: ALPHA, heading_path: ["Alpha"] }] }) });
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA]);
    expect(replica.requireLiveSection(SectionId.brand(BETA))).toBeUndefined();
  });

  it("COLD-START: an update frame before any bootstrap leaves the replica not-ready and nothing default-editable", () => {
    // A topology/lock change that races ahead of the bootstrap must NOT flip the
    // replica to ready — the client can only become ready from an actor-captured
    // bootstrap. Consumers gate on `hasAuthoritativeBootstrap` (paint seeds until then), and nothing is
    // editable without an explicit `enableEditing`, so no default-editable state
    // can leak from a stray pre-bootstrap frame.
    const replica = createLiveSectionReplica();
    replica.applyUpdate({ state: state() });
    expect(replica.hasAuthoritativeBootstrap).toBe(false);
    // Membership may resolve from the stray frame's topology, but it is never editable
    // without an explicit enableEditing — and membership is NOT authoritative access.
    const alpha = replica.lookupInTopology(SectionId.brand(ALPHA));
    if (alpha) expect(alpha.isEditable()).toBe(false);
    // The authoritative-access gate must refuse the cold path: requireLiveSection throws
    // until a bootstrap lands, so no default-editable / stale-topology live access leaks.
    expect(() => replica.requireLiveSection(SectionId.brand(ALPHA))).toThrow(/authoritative bootstrap/);
  });

  it("RECONNECT: a fresh complete bootstrap replaces prior state wholesale (no replay/merge)", () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({ docSessionId: "sess-1", state: state(), yjsUpdate: seedDocUpdate() });
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, BETA]);

    // A reconnect delivers a brand-new complete bootstrap (new session id, a
    // topology where Beta is gone and a new Gamma exists). It must be adopted as
    // the whole truth — Beta must not linger from the previous bootstrap.
    const GAMMA = "section::gamma";
    const reconnectDoc = new Y.Doc();
    writeFragment(reconnectDoc, ALPHA, "# Alpha\n\nAlpha reconnected");
    writeFragment(reconnectDoc, GAMMA, "## Gamma\n\nGamma body");
    replica.applyBootstrap({
      docSessionId: "sess-2",
      state: {
        topology: [
          { fragment_key: ALPHA, heading_path: ["Alpha"] },
          { fragment_key: GAMMA, heading_path: ["Alpha", "Gamma"] },
        ],
        blocked_section_ids: [],
        pending_sections: [],
        publish_pause_join_mirror: "not_in_pause",
      },
      yjsUpdate: Y.encodeStateAsUpdate(reconnectDoc),
    });
    reconnectDoc.destroy();

    expect(replica.hasAuthoritativeBootstrap).toBe(true);
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, GAMMA]);
    expect(replica.requireLiveSection(SectionId.brand(BETA))).toBeUndefined();
    expect(replica.requireLiveSection(SectionId.brand(GAMMA))!.readMarkdown()).toContain("Gamma body");
  });

  it("SESSION-END (4021): resetForSessionEnd drops live authority — not-ready, no topology, nothing editable — and notifies once", async () => {
    const replica = createLiveSectionReplica();
    replica.applyBootstrap({ docSessionId: "sess-1", state: state(), yjsUpdate: seedDocUpdate() });
    replica.setLocalWriteCapability(true);
    expect(replica.hasAuthoritativeBootstrap).toBe(true);
    expect(replica.requireLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(true);

    let notifications = 0;
    const unsubscribe = replica.subscribe(() => {
      notifications++;
      // The reset notification observes a fully-applied state: the replica is
      // NOT-ready with an empty topology (consumers revert to cold seeds).
      expect(replica.hasAuthoritativeBootstrap).toBe(false);
      expect(replica.getTopology()).toEqual([]);
    });

    replica.resetForSessionEnd();
    unsubscribe();

    expect(notifications).toBe(1);
    expect(replica.hasAuthoritativeBootstrap).toBe(false);
    expect(replica.getTopology()).toEqual([]);
    // Live authority is gone: the section is no longer resolvable, so nothing is
    // editable and there is no default-editable state to leak until a fresh bootstrap.
    expect(replica.lookupInTopology(SectionId.brand(ALPHA))).toBeUndefined();

    // A fresh actor-captured bootstrap for a NEW session re-establishes authority
    // wholesale (no replay of the ended session's state).
    replica.applyBootstrap({ docSessionId: "sess-2", state: state(), yjsUpdate: seedDocUpdate() });
    expect(replica.hasAuthoritativeBootstrap).toBe(true);
    expect(replica.getTopology().map((r) => SectionId.text(r.id))).toEqual([ALPHA, BETA]);
    // Editing capability did NOT survive the session end — must re-enable explicitly.
    expect(replica.requireLiveSection(SectionId.brand(ALPHA))!.isEditable()).toBe(false);
  });
});
