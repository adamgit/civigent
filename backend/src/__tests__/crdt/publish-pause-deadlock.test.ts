/**
 * C2 — the publish pause must NOT hold the actor lane while awaiting editor
 * readiness (the deadlock fix), and the spec-10 readiness ordering invariant must
 * hold across the off-lane `markReady`.
 *
 * Before C2, `runPublishAttempt` ran as ONE lane command that `await`ed the
 * readiness promise, while the `doc_publish_ready` ack was relayed by ENQUEUING
 * `markReady` onto the SAME serial lane — so the ack could never run and the
 * publish only resolved via the 10 s timeout (→ aborted). canonical therefore
 * advanced only when every editor disconnected (empty required set short-circuit).
 *
 * These tests drive the REAL coordinator orchestration with a non-empty required
 * editor set (a registered fake editor socket) and assert:
 *  (1) the lane is FREE during the readiness wait (an independently-enqueued lane
 *      command runs while the publish is still pending) and an off-lane ready ack
 *      drives the publish to COMMIT — no timeout/abort;
 *  (2) the multi-editor case requires every required socket to ack before commit;
 *  (3) a required socket disconnecting before acking ABORTS (proposal stays
 *      `inprogress`); and
 *  (4) a prior YJS update enqueued before the off-lane `markReady` is applied to
 *      the proposal before the ready-triggered finalize snapshots (ordering).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  processArbitratedClientUpdate,
  requestDocSessionPublish,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

function buildClientUpdateForOverview(session: DocSession, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(OVERVIEW_KEY, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

/** Poll a predicate across macrotask ticks (real timers). Throws on timeout. */
async function waitUntil(pred: () => boolean, label: string, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`waitUntil timed out: ${label}`);
}

/** Materialize a first edit so the DocSession owns a committable inprogress proposal. */
async function seedProposalEdit(session: DocSession, body: string): Promise<void> {
  const update = buildClientUpdateForOverview(session, buildFragmentContent(body as SectionBody, 2, "Overview"));
  await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));
  expect(session.generator.hasCurrentProposal()).toBe(true);
}

describe("C2: publish pause does not deadlock on the actor lane", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => {});
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("(1) does NOT hold the lane during the readiness wait; an off-lane ack commits", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1").dispose);
    await seedProposalEdit(session, "deadlock regression body");

    // Trigger a publish (forced op path). With a required editor socket present it
    // must take the OFF-lane readiness wait, NOT the synchronous fast path.
    const pub = requestDocSessionPublish(SAMPLE_DOC_PATH);
    let pubSettled = false;
    void pub.then(() => { pubSettled = true; });

    // Wait until the pause is established (Phase 1 ran + freed the lane).
    await waitUntil(() => session.publishPause.isActive(), "pause active");

    // The lane MUST be free during the wait: an independently-enqueued command
    // runs to completion WHILE the publish is still pending. Under the old
    // lane-held implementation this command would never run until the publish
    // settled (it would hang here until the readiness timeout).
    const markerRanWhilePending = await session.enqueue(() => !pubSettled);
    expect(markerRanWhilePending).toBe(true);
    expect(pubSettled).toBe(false);
    expect(session.publishPause.isActive()).toBe(true);

    // Deliver the readiness ack the way the (post-C2) handler does: directly,
    // off the lane. This resolves the wait and the second lane command commits.
    session.publishPause.markReady("editor-sock-1");

    const outcome = await pub;
    expect(outcome.outcome).toBe("committed");
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  it("(2) multi-editor: every required socket must ack before commit", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1").dispose);
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-2").dispose);
    await seedProposalEdit(session, "multi editor body");

    const pub = requestDocSessionPublish(SAMPLE_DOC_PATH);
    let pubSettled = false;
    void pub.then(() => { pubSettled = true; });
    await waitUntil(() => session.publishPause.isActive(), "pause active");

    // First ack alone is NOT enough.
    session.publishPause.markReady("editor-sock-1");
    await session.enqueue(() => undefined); // let any lane work settle
    expect(pubSettled).toBe(false);
    expect(session.publishPause.isActive()).toBe(true);

    // Second ack completes the frontier → commit.
    session.publishPause.markReady("editor-sock-2");
    const outcome = await pub;
    expect(outcome.outcome).toBe("committed");
  });

  it("(3) a required socket disconnecting before acking ABORTS; proposal stays inprogress", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1").dispose);
    await seedProposalEdit(session, "abort body");
    const proposalId = session.generator.getCurrentProposalId();

    const pub = requestDocSessionPublish(SAMPLE_DOC_PATH);
    await waitUntil(() => session.publishPause.isActive(), "pause active");

    // The required editor disconnects before acking → abort (spec 10 step 7).
    session.publishPause.handleSocketDisconnect("editor-sock-1");

    const outcome = await pub;
    expect(outcome.outcome).toBe("aborted");
    // The in-flight proposal is retained as the DocSession's current proposal.
    expect(session.generator.hasCurrentProposal()).toBe(true);
    expect(session.generator.getCurrentProposalId()).toBe(proposalId);
  });

  it("(4) a prior YJS update enqueued before the ready ack is committed (ordering)", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock-1").dispose);
    await seedProposalEdit(session, "ordering base body");

    const pub = requestDocSessionPublish(SAMPLE_DOC_PATH);
    await waitUntil(() => session.publishPause.isActive(), "pause active");

    // The editor's LAST update (sent before `doc_publish_ready`) is enqueued onto
    // the lane. We do NOT await it before delivering readiness: the off-lane
    // `markReady` resolves the wait and the finalize is ENQUEUED behind this
    // update, so FIFO lane ordering guarantees it materializes before the
    // finalize snapshots (spec 10 §Readiness ordering invariant).
    const PRIOR = "FINAL EDIT BEFORE READY ACK";
    const update = buildClientUpdateForOverview(session, buildFragmentContent(PRIOR as SectionBody, 2, "Overview"));
    const applied = session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // Deliver readiness immediately (off-lane), racing the still-queued update.
    session.publishPause.markReady("editor-sock-1");

    const outcome = await pub;
    await applied;
    expect(outcome.outcome).toBe("committed");

    // The prior update was applied before the finalize snapshot → it is in canonical.
    const canonical = await CanonicalReader.open().readSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(canonical).toContain(PRIOR);
  });
});
