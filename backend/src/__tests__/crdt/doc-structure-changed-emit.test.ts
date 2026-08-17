/**
 * Live structural-change emission on the DocSession CRDT channel.
 *
 * The live-section redesign (new-frontend-live-document-design.md) moved live
 * topology authority OFF the application WebSocket: there is no longer a
 * `doc:structure-changed` app event carrying a rich, body-bearing section list.
 * Instead, whenever a live structural change is applied to an open DocSession's
 * Y.Doc, the coordinator broadcasts ONE ordered `LiveSectionsUpdateFrame`
 * (opcode 0x15) to bootstrapped live recipients carrying BOTH the Yjs update and
 * the resulting body-free `state.topology` — so a client never observes half the
 * structural fact.
 *
 * These pin the BACKEND emit contract:
 *   - it fires from `normalizeQuiescedStructure` for a sibling split / merge /
 *     rename, with the correct ordered, body-free topology (`fragment_key` +
 *     `heading_path` only — no body, no `section_file`, no `last_editor`);
 *   - it fires from `applyCommittedCanonicalToLiveSession` (a cross-client / agent
 *     commit reshaping an open live doc);
 *   - the frame is the SOLE structural broadcast: no raw `MSG_YJS_UPDATE`
 *     precursor is sent for structural changes (structural body+topology travel
 *     as one atomic frame; ordinary body edits are a separate sole-path contract
 *     on content-only live-section frames).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  joinAndNotify,
  registerFakeObserverSocketForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
  applyCommittedCanonicalToLiveSession,
} from "../../ws/crdt-ws-coordinator.js";
import {
  MSG_YJS_UPDATE,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeMessage,
  decodeLiveSectionsUpdate,
} from "../../ws/crdt-ws-frames.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import type { WireLiveSectionsState, WireLiveSectionRef } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

/** Every raw frame a live recipient received, in send order. */
let sent: Uint8Array[];

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/**
 * Register an observer socket and bootstrap it onto the live-section channel so
 * it receives ordered `LiveSectionsUpdateFrame`s; records every raw frame it is
 * sent onto the shared `sent` timeline. Bootstrap frames are drained/discarded
 * so the test watches only the structural emission that follows.
 */
async function joinLiveRecipient(session: DocSession, disposers: Array<() => void>): Promise<void> {
  const reg = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "live-recipient", undefined, (d) => sent.push(d));
  disposers.push(reg.dispose);
  reg.state.joined = false;
  joinAndNotify(session, reg.socket, reg.state);
  await session.enqueue(() => undefined); // drain the lane so the bootstrap send lands
  sent.length = 0; // discard bootstrap; watch only the structural update that follows
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

function setFragmentViaMinimalDiff(session: DocSession, key: string, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(markdown));
  session.ydoc.transact(() => updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }));
}

/** All live-section UPDATE frames received, in order. */
function updateFrames() {
  return sent
    .map((d) => decodeMessage(d))
    .filter((m): m is { type: number; payload: Uint8Array } => !!m && m.type === MSG_LIVE_SECTIONS_UPDATE)
    .map((m) => decodeLiveSectionsUpdate(m.payload));
}

/** The topology from the last structural update frame (one that carries `state`). */
function lastStructuralState(): WireLiveSectionsState {
  const structural = updateFrames().filter((u) => u.state !== undefined);
  expect(structural.length).toBeGreaterThanOrEqual(1);
  // A structural frame carries BOTH the Yjs update and fresh topology.
  expect(structural[structural.length - 1].yjs_update).toBeDefined();
  return structural[structural.length - 1].state!;
}

/** The topology is body-free: `fragment_key` + `heading_path` + `heading_level` only, no body/file/editor. */
function assertBodyFree(state: WireLiveSectionsState): void {
  for (const ref of state.topology) {
    expect(typeof ref.fragment_key).toBe("string");
    expect(ref.fragment_key.length).toBeGreaterThan(0);
    expect(Array.isArray(ref.heading_path)).toBe(true);
    // No body/topology-forbidden fields leaked onto the live ref.
    expect(Object.keys(ref).sort()).toEqual(["fragment_key", "heading_level", "heading_path"]);
  }
}

/**
 * Structural fan-out is the live-section frame ONLY: a raw `MSG_YJS_UPDATE`
 * sent before the structural frame would let a client observe the Y.Doc
 * mutation while its topology/editability still describe the old structure.
 * These scenarios are purely structural, so NO raw Yjs frame may appear before
 * the first structural `MSG_LIVE_SECTIONS_UPDATE`.
 */
function assertNoRawStructuralPrecursor(): void {
  const opcodes = sent.map((d) => decodeMessage(d)).map((m) => m?.type);
  const firstUpdate = opcodes.indexOf(MSG_LIVE_SECTIONS_UPDATE);
  expect(firstUpdate).toBeGreaterThanOrEqual(0);
  expect(opcodes.slice(0, firstUpdate)).not.toContain(MSG_YJS_UPDATE);
}

function findByHeadingPath(topology: readonly WireLiveSectionRef[], headingPath: string[]) {
  return topology.find((s) => SectionRef.headingKey(s.heading_path) === SectionRef.headingKey(headingPath));
}

describe("live structural-change emission on the CRDT channel", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    sent = [];
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    setCrdtEventHandler(() => {});
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("SIBLING SPLIT: emits an ordered body-free topology (survivor + promoted sibling) as one atomic frame (no raw precursor)", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    await joinLiveRecipient(session, disposers);

    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    await fireQuiescence(session);

    const state = lastStructuralState();
    assertBodyFree(state);
    assertNoRawStructuralPrecursor();

    // The survivor and the promoted sibling are both present…
    const overview = findByHeadingPath(state.topology, ["Overview"]);
    const second = findByHeadingPath(state.topology, ["Second Section"]);
    const timeline = findByHeadingPath(state.topology, ["Timeline"]);
    expect(overview).toBeDefined();
    expect(second).toBeDefined();
    expect(timeline).toBeDefined();
    // …in document order: Overview → Second Section → Timeline.
    expect(state.topology.indexOf(overview!)).toBeLessThan(state.topology.indexOf(second!));
    expect(state.topology.indexOf(second!)).toBeLessThan(state.topology.indexOf(timeline!));
    // The survivor keeps its own fragment identity (distinct from the new sibling);
    // the promoted heading is NOT re-keyed onto the survivor's key.
    expect(overview!.fragment_key).toBe(OVERVIEW_KEY);
    expect(second!.fragment_key).not.toBe(overview!.fragment_key);
    expect(second!.fragment_key.length).toBeGreaterThan(0);
  });

  it("MERGE: emits a topology that DROPS the merged-away section as one atomic frame (no raw precursor)", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    await joinLiveRecipient(session, disposers);

    // Delete the Timeline heading line → Timeline folds into Overview.
    setFragmentViaMinimalDiff(session, TIMELINE_KEY, "Q1: Planning. Q2: Execution. Q3: Review. CHANGED.");
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    await fireQuiescence(session);

    const state = lastStructuralState();
    assertBodyFree(state);
    assertNoRawStructuralPrecursor();
    // Timeline is gone from the live topology; Overview survives.
    expect(state.topology.map((t) => t.fragment_key)).not.toContain(TIMELINE_KEY);
    expect(findByHeadingPath(state.topology, ["Timeline"])).toBeUndefined();
    expect(findByHeadingPath(state.topology, ["Overview"])).toBeDefined();
  });

  it("RENAME: emits a topology with the renamed heading path as one atomic frame (no raw precursor)", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    await joinLiveRecipient(session, disposers);

    setFragmentViaMinimalDiff(
      session,
      OVERVIEW_KEY,
      "## Strategic Overview\n\nThe overview covers our strategic goals. CHANGED.",
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    await fireQuiescence(session);

    const state = lastStructuralState();
    assertBodyFree(state);
    assertNoRawStructuralPrecursor();
    const renamed = findByHeadingPath(state.topology, ["Strategic Overview"]);
    expect(renamed).toBeDefined();
    // Rename keeps the fragment identity (heading edit, not delete/create).
    expect(renamed!.fragment_key).toBe(OVERVIEW_KEY);
    expect(findByHeadingPath(state.topology, ["Overview"])).toBeUndefined();
  });

  it("CROSS-CLIENT: an external canonical commit applied to the live session emits as one atomic frame (no raw precursor)", async () => {
    const session = await openSession();
    await joinLiveRecipient(session, disposers);

    // A SEPARATE writer commits a change to Overview via a distinct proposal.
    const { id: externalProposalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "edit overview externally",
    );
    await mutateProposalContent(externalProposalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      heading: "Overview",
      content: "EXTERNALLY COMMITTED OVERVIEW",
    });
    const absorb = await publishProposalToCanonicalDetailed(externalProposalId, {});
    const changedHeadingPaths = absorb.changedSections.map((s) => [...s.headingPath]);

    await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, changedHeadingPaths, externalProposalId);
    await session.enqueue(() => undefined);

    const state = lastStructuralState();
    assertBodyFree(state);
    assertNoRawStructuralPrecursor();
    // The live topology still resolves Overview (the external body rides the Yjs update).
    expect(findByHeadingPath(state.topology, ["Overview"])).toBeDefined();
  });
});
