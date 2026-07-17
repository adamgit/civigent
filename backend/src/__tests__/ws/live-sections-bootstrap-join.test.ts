/**
 * Actor-ordered live-section bootstrap/join on the DocSession CRDT lane.
 *
 *   1) A joining socket receives a `LiveSectionsBootstrapFrame` whose `state`
 *      matches the live layout captured on the actor lane (topology by
 *      fragment_key/heading_path, empty blocked set, pause mirror false).
 *   2) A subsequent structural change (heading-deletion merge at quiescence)
 *      produces a `LiveSectionsUpdateFrame` carrying BOTH a Yjs update and the
 *      resulting `state` — one frame for the whole structural fact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  joinAndNotify,
  registerFakeObserverSocketForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import {
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeLiveSectionsBootstrap,
  decodeLiveSectionsUpdate,
  decodeMessage,
} from "../../ws/crdt-ws-frames.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { buildWireLiveSectionsState } from "../../crdt/live-sections-wire-state.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";
import * as Y from "yjs";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";
const TIMELINE_DEMOTION_MARKDOWN = `Timeline\n\n${SAMPLE_SECTIONS.timeline}`;

/** Lock a section with a competing human `inprogress` proposal (predates join). */
async function lockSection(headingPath: string[]): Promise<void> {
  const { id } = await createProposal(
    { id: "user-bob", type: "human", displayName: "Bob" },
    "Competing lock",
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: headingPath }],
  );
  expect((await transitionToInProgress(id)).acquired).toBe(true);
}

function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() =>
    updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }),
  );
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

describe("live-section bootstrap/join on the DocSession CRDT lane", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("sends an actor-captured bootstrap frame matching the live layout on join", async () => {
    const session = await openSession();
    const sent: Uint8Array[] = [];
    const reg = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "obs-1", undefined, (d) => sent.push(d));
    disposers.push(reg.dispose);

    // joinAndNotify enqueues the bootstrap; flip `joined` back to false so it runs.
    reg.state.joined = false;
    joinAndNotify(session, reg.socket, reg.state);
    await session.enqueue(() => undefined); // drain the lane so the bootstrap send lands.

    const bootstraps = sent
      .map((d) => decodeMessage(d))
      .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === MSG_LIVE_SECTIONS_BOOTSTRAP)
      .map((m) => decodeLiveSectionsBootstrap(m.payload));
    expect(bootstraps).toHaveLength(1);
    const frame = bootstraps[0];

    expect(frame.doc_session_id).toBe(session.docSessionId);
    expect(frame.yjs_update.length).toBeGreaterThan(0);
    expect(frame.state.publish_pause_join_mirror).toBe("not_in_pause");
    expect(frame.state.blocked_section_ids).toEqual([]);

    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, session.generator.getCurrentProposalId());
    expect(frame.state.topology.map((t) => t.fragment_key)).toEqual(layout.map((e) => e.fragmentKey));
    expect(frame.state.topology.map((t) => t.heading_path)).toEqual(layout.map((e) => e.headingPath));
  });

  it("PENDING: the wire state carries the live pending-writer set, filtered to topology", async () => {
    // Task 572: `pending_sections` is sourced from the coordinator's live pending set
    // (writer identity retained) and filtered to fragments actually in the topology —
    // a stale pending entry for a merged-away fragment must never leak onto the wire.
    const session = await openSession();
    disposers.push(() => undefined);

    const state = await session.enqueue(() =>
      buildWireLiveSectionsState(session, [
        { fragment_key: OVERVIEW_KEY, writer_id: "user-alice", writer_display_name: "Alice" },
        { fragment_key: "section::ghost", writer_id: "user-bob", writer_display_name: "Bob" },
      ]),
    );

    // Overview is in topology → carried with its writer identity; the ghost fragment
    // (not in topology) is filtered out.
    expect(state.pending_sections).toEqual([
      { fragment_key: OVERVIEW_KEY, writer_id: "user-alice", writer_display_name: "Alice" },
    ]);
    // The default (no pending arg) stays empty — no accidental population.
    const emptyState = await session.enqueue(() => buildWireLiveSectionsState(session));
    expect(emptyState.pending_sections).toEqual([]);
  });

  it("emits a structural update frame (yjs_update + state) at a quiescence merge", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const sent: Uint8Array[] = [];
    const reg = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "obs-2", undefined, (d) => sent.push(d));
    disposers.push(reg.dispose);
    reg.state.joined = false;
    joinAndNotify(session, reg.socket, reg.state);
    await session.enqueue(() => undefined);
    sent.length = 0; // discard bootstrap; watch only for the structural update.

    // Demote Timeline's heading to body and quiesce so the merge runs.
    setFragmentViaMinimalDiff(session, TIMELINE_KEY, TIMELINE_DEMOTION_MARKDOWN);
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await session.enqueue(() => undefined);

    const updates = sent
      .map((d) => decodeMessage(d))
      .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === MSG_LIVE_SECTIONS_UPDATE)
      .map((m) => decodeLiveSectionsUpdate(m.payload));

    const structural = updates.filter((u) => u.state !== undefined);
    expect(structural.length).toBeGreaterThanOrEqual(1);
    // The structural frame carries BOTH the Yjs update and fresh topology.
    expect(structural[0].yjs_update).toBeDefined();
    // Timeline merged into its predecessor, so its key must be gone from topology.
    expect(structural[structural.length - 1].state!.topology.map((t) => t.fragment_key)).not.toContain(TIMELINE_KEY);
  });

  it("COLD-START: a lock predating the join is seeded in the bootstrap blocked set (never missed / never default-editable)", async () => {
    // The section is exclusively locked BEFORE any socket connects — the classic
    // "topology/lock change concurrent with startup" race. The joining client must
    // become ready from a bootstrap that already reflects the lock, not from a
    // stale/default-editable baseline it would have to correct later.
    await lockSection(["Timeline"]);
    const session = await openSession();
    const sent: Uint8Array[] = [];
    const reg = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "obs-cold", undefined, (d) => sent.push(d));
    disposers.push(reg.dispose);
    reg.state.joined = false;
    joinAndNotify(session, reg.socket, reg.state);
    await session.enqueue(() => undefined);

    const bootstrap = sent
      .map((d) => decodeMessage(d))
      .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === MSG_LIVE_SECTIONS_BOOTSTRAP)
      .map((m) => decodeLiveSectionsBootstrap(m.payload))[0];
    expect(bootstrap).toBeDefined();
    // The lock is present in the very first frame — editability was never default-open.
    expect(bootstrap.state.blocked_section_ids).toContain(TIMELINE_KEY);
    // Topology still lists the locked section (blocked ≠ gone).
    expect(bootstrap.state.topology.map((t) => t.fragment_key)).toContain(TIMELINE_KEY);
  });

  it("RECONNECT: a fresh join after edits gets a complete bootstrap (full state + Y.Doc), not a replay delta", async () => {
    const session = await openSession();
    // First client edits Overview, materializing live state on the server Y.Doc.
    setFragmentViaMinimalDiff(session, OVERVIEW_KEY, "## Overview\n\nRECONNECT edited body");
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    // A SECOND socket connects (a reconnect / late joiner). It must receive one
    // complete actor-captured bootstrap that already carries the prior edit — there
    // is no event/revision replay log; WebSocket ordering is the only cursor.
    const sent: Uint8Array[] = [];
    const reg = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "obs-reconnect", undefined, (d) => sent.push(d));
    disposers.push(reg.dispose);
    reg.state.joined = false;
    joinAndNotify(session, reg.socket, reg.state);
    await session.enqueue(() => undefined);

    const bootstrap = sent
      .map((d) => decodeMessage(d))
      .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === MSG_LIVE_SECTIONS_BOOTSTRAP)
      .map((m) => decodeLiveSectionsBootstrap(m.payload))[0];
    expect(bootstrap).toBeDefined();
    // Complete topology + a full Y.Doc update (not a delta) that already reflects
    // the prior edit — replaying it into an empty doc yields the edited body.
    expect(bootstrap.yjs_update.length).toBeGreaterThan(0);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, bootstrap.yjs_update);
    expect(replica.getXmlFragment(OVERVIEW_KEY).toString()).toContain("RECONNECT edited body");
    replica.destroy();
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, session.generator.getCurrentProposalId());
    expect(bootstrap.state.topology.map((t) => t.fragment_key)).toEqual(layout.map((e) => e.fragmentKey));
  });

  it("PUBLISH-PAUSE MIRROR: a joiner mid-pause sees publish_pause_join_mirror = pause_active_editors_frozen in its bootstrap (mirror only, not the handshake)", async () => {
    const session = await openSession();
    // Start a publish pause with a required editor socket so it stays active
    // ("pausing"); the returned promise is aborted in the finally to avoid a
    // dangling readiness timer. The opcode handshake (0x10/0x11/0x12) is what
    // actually freezes editors — this only checks the join-time UI mirror.
    const waiter = session.publishPause.start(["some-editor-sock"]);
    try {
      expect(session.publishPause.isActive()).toBe(true);

      const sent: Uint8Array[] = [];
      const reg = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "obs-pause", undefined, (d) => sent.push(d));
      disposers.push(reg.dispose);
      reg.state.joined = false;
      joinAndNotify(session, reg.socket, reg.state);
      await session.enqueue(() => undefined);

      const bootstrap = sent
        .map((d) => decodeMessage(d))
        .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === MSG_LIVE_SECTIONS_BOOTSTRAP)
        .map((m) => decodeLiveSectionsBootstrap(m.payload))[0];
      expect(bootstrap).toBeDefined();
      // The mirror reflects the active pause for join-time UI…
      expect(bootstrap.state.publish_pause_join_mirror).toBe("pause_active_editors_frozen");
    } finally {
      session.publishPause.abort();
      await waiter;
    }
  });
});
