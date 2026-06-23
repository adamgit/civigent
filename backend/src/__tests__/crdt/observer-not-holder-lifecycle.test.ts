/**
 * Claim 2 — observers are NOT session holders; last-editor-leave closes observers
 * with 4021 and discards the Y.Doc.
 *
 * Spec 05 §Observer CRDT Channel › Session Lifecycle: "Observer connections do not
 * call `acquireDocSession` — they never become session holders"; "Observer
 * disconnection has no effect on Y.Doc retention policy or commit cadence"; "When
 * the last editor disconnects … observer sockets are notified via close code 4021".
 *
 * These tests prove:
 *  (a) an observer does NOT become a holder and does NOT keep the Y.Doc alive after
 *      the last editor leaves (the Y.Doc is discarded);
 *  (b) the observer socket receives a 4021 close on last-editor-leave, AFTER the
 *      autonomous publish committed;
 *  (c) an observer-only connection (no editor ever) does not pin a Y.Doc/actor lane;
 *  (d) regression guard: observers do not count toward the publish trigger — the
 *      last-editor publish still fires with an observer attached.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  releaseDocSession,
  lookupDocSession,
  addObserverSocket,
  countEditorSockets,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import {
  publishOnLastEditorDisconnect,
  registerFakeObserverSocketForTest,
  closeObserverSocketsForDocForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { findInProgressProposalForDoc } from "../../storage/proposal-repository.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openEditorSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-editor-1");
}

async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

describe("Claim 2: observers are not holders; 4021 on last-editor-leave", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("an observer does not become a holder and does not keep the Y.Doc alive after the last editor leaves", async () => {
    const session = await openEditorSession();
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("edited before observer joined" as SectionBody, 2, "Overview"),
    );
    await session.generator.materializeEdit();

    // An observer attaches. It MUST NOT enter `holders` (editor-only refcount).
    addObserverSocket(session, "sock-observer-1");
    expect(session.holders.size).toBe(1); // the single editor holder only
    expect(session.observerSocketIds.has("sock-observer-1")).toBe(true);
    expect(countEditorSockets(session)).toBe(1);

    // Last editor leaves: publish, then release. With the observer no longer a
    // holder, releasing the editor drives holders.size === 0 → Y.Doc discarded
    // EVEN THOUGH an observer socket remains.
    await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);
    const released = await releaseDocSession(SAMPLE_DOC_PATH, WRITER.id, "sock-editor-1");

    expect(released.sessionEnded).toBe(true);
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
  });

  it("closes observer sockets with 4021 on last-editor-leave, after the publish committed", async () => {
    const session = await openEditorSession();
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("published before observers evicted" as SectionBody, 2, "Overview"),
    );
    const proposalId = await session.generator.materializeEdit();
    expect((await findInProgressProposalForDoc(SAMPLE_DOC_PATH))?.id).toBe(proposalId);

    const closes: Array<{ code: number; reason: string }> = [];
    const obs = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "sock-observer-1", (code, reason) =>
      closes.push({ code, reason }),
    );

    // Production close-handler order: publish → close observers (4021) → discard.
    await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);
    // The publish has landed before observers are evicted: the proposal committed.
    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(await findInProgressProposalForDoc(SAMPLE_DOC_PATH)).toBeNull();

    const closedCount = closeObserverSocketsForDocForTest(SAMPLE_DOC_PATH);
    await releaseDocSession(SAMPLE_DOC_PATH, WRITER.id, "sock-editor-1");

    expect(closedCount).toBe(1);
    expect(closes).toEqual([{ code: 4021, reason: "session_ended" }]);

    obs.dispose();
  });

  it("an observer-only connection (no editor ever) does not pin a Y.Doc / actor lane", async () => {
    // No editor ever calls acquireDocSession, so there is no live Y.Doc for the
    // doc. An observer attaching in this state is parked "waiting_for_session" and
    // pins nothing.
    const obs = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "sock-observer-only");
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
    obs.dispose();
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
  });

  it("regression: observers do not count toward the publish trigger (last-editor publish still fires)", async () => {
    const session = await openEditorSession();
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("still publishes with observer present" as SectionBody, 2, "Overview"),
    );
    await session.generator.materializeEdit();

    // An observer is attached, but it is not an editor: the last-editor publish
    // must still fire (countEditorSockets / activeEditorSocketIds are editor-only).
    addObserverSocket(session, "sock-observer-1");
    const obs = registerFakeObserverSocketForTest(SAMPLE_DOC_PATH, "sock-observer-1");

    const decision = await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);

    expect(decision.shouldPublish).toBe(true);
    expect(session.generator.hasCurrentProposal()).toBe(false);

    obs.dispose();
  });
});
