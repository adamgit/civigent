/**
 * Autonomous publish lifecycle (spec 10 §15 "One active proposal per DocSession",
 * §"Publish failure handling"; spec 05 §Proposal Publication).
 *
 * Feature-completion checks for the full successful auto-publish lifecycle, not
 * just the current-proposal-cleared flag the wiring test (MW-1b) covers:
 *
 *  1. A settled-dirty-frontier autonomous publish transitions the live
 *     DocSession proposal to `committed` (spec: "until a successful publish
 *     clears the current proposal reference").
 *  2. The current-proposal reference is cleared ONLY after the commit succeeds —
 *     before the publish fires it still points at the same proposal, and the
 *     edit reaches canonical (proving the clear followed a real commit, not a
 *     premature drop).
 *  3. The NEXT edit lazily creates the NEXT proposal — a distinct `inprogress`
 *     proposal id, never a reuse of the committed one and never a second live
 *     proposal created to skip the publish.
 *
 * These exercise the REAL actor-lane quiescence → publish machinery
 * (`armQuiescenceTimer` → `runQuiescenceCommand` → `finalizeAndPublish` → commit
 * pipeline) against a real `DocSession` Y.Doc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { readSection } from "../../storage/section-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const EDITOR_SOCKET = "editor-sock-1";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Flush the actor lane so any enqueued quiescence/publish command settles. */
async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

/**
 * Ack an OFF-lane publish pause (a required editor socket is attached) the way
 * the post-C2 handler does — directly, off the lane — and pump fake timers until
 * the finalize lane command commits and clears the current proposal. The
 * proposal-cleared-on-success assertions thus run through the production
 * editor-ack path, not the inline empty-required-set short-circuit.
 */
async function ackPauseAndCommit(session: DocSession, socketId: string): Promise<void> {
  expect(session.publishPause.isActive()).toBe(true);
  expect(session.generator.hasCurrentProposal()).toBe(true);
  session.publishPause.markReady(socketId);
  for (let i = 0; i < 50 && session.generator.hasCurrentProposal(); i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  await drainLane(session);
}

/** Edit Overview's live fragment and mark it active "now". */
function editOverview(
  session: Awaited<ReturnType<typeof openSession>>,
  body: string,
) {
  session.liveFragments.replaceFragmentString(
    OVERVIEW_KEY,
    buildFragmentContent(body as SectionBody, 2, "Overview"),
  );
  session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
}

describe("autonomous publish lifecycle (spec 10 §One active proposal per DocSession)", () => {
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
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("commits the live proposal, clears the reference only after success, and the next edit creates the next proposal", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    // A live editor socket is attached, so the publish runs the production
    // off-lane pause + editor ack (proposal-cleared-on-success is proven through
    // that path, not the inline empty-required-set short-circuit).
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET).dispose);

    // First edit → lazily creates the single inprogress proposal.
    editOverview(session, "autonomously published body");
    const firstProposalId = await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);
    // Not cleared yet — the reference still points at the proposal pre-publish.
    expect(session.generator.getCurrentProposalId()).toBe(firstProposalId);
    expect((await readProposal(firstProposalId)).status).toBe("inprogress");
    // Canonical is still the original body (publish has not happened).
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);

    // Go quiet → settled-dirty-frontier autonomous publish fires the OFF-lane pause.
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(
      session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50,
    );
    await drainLane(session);

    // Off-lane path: the pause is active and the proposal is still in flight (no
    // inline commit) — the reference must NOT clear until the editor acks and the
    // commit succeeds. Ack now to drive the real editor-ack commit.
    await ackPauseAndCommit(session, EDITOR_SOCKET);

    // (1) The live proposal transitioned to committed.
    expect((await readProposal(firstProposalId)).status).toBe("committed");
    // (2) The current-proposal reference is cleared — only after a real commit
    // that pushed the edit into canonical.
    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(session.generator.getCurrentProposalId()).toBeNull();
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain(
      "autonomously published body",
    );

    // (3) The next edit creates the NEXT proposal — a fresh inprogress id,
    // never a reuse of the committed proposal.
    editOverview(session, "second round body");
    const secondProposalId = await session.generator.materializeEdit();
    expect(secondProposalId).not.toBe(firstProposalId);
    expect(session.generator.getCurrentProposalId()).toBe(secondProposalId);
    expect((await readProposal(secondProposalId)).status).toBe("inprogress");
  });
});
