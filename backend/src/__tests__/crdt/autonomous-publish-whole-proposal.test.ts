/**
 * V1 publishes the WHOLE current DocSession proposal (spec 10 §15 "One active
 * proposal per DocSession"; spec 05 §Proposal Publication).
 *
 * The per-edit materialize grows the proposal's section claim MONOTONICALLY
 * (`unionCurrentProposalSections`) as each section is edited. The autonomous
 * publish must commit the WHOLE accumulated proposal — every section edited
 * across the session — NOT a smaller subset selected from the first/early edit.
 *
 * This guards against a regression where publish would scope to only the early
 * activity (e.g. the first touched fragment) and silently drop later edits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  requestDocSessionPublish,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { readSection } from "../../storage/section-reader.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";
const EDITOR_SOCKET = "editor-sock-1";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

/**
 * Deliver the editor's `doc_publish_ready` ack the way the post-C2 handler does —
 * directly, off the actor lane — and drive the OFF-lane pause to a real commit.
 *
 * With a registered editor socket the settled-dirty-frontier autonomous publish
 * takes the production off-lane readiness wait (`runPublishAttempt`), NOT the
 * inline empty-required-set short-circuit: the pause is active and the proposal is
 * still in flight until the required socket acks. We then markReady and pump fake
 * timers until the second lane command (`finalizeAndEnd`) commits and clears the
 * current-proposal reference.
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

describe("autonomous publish commits the whole current proposal (spec 10 §One active proposal)", () => {
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

  it("publishes every section edited across the session, not just the early-activity subset", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    // A live editor socket is attached, so the autonomous publish MUST route
    // through the production off-lane pause + editor ack — not the inline
    // empty-required-set path that the unit-isolated probe took.
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET).dispose);

    // Early activity: edit Overview, materialized scoped to ONLY that fragment.
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("new overview body" as SectionBody, 2, "Overview"),
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    // Later activity: edit Timeline, materialized scoped to ONLY that fragment.
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      buildFragmentContent("new timeline body" as SectionBody, 2, "Timeline"),
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    // Quiesce → the timer normalizes only; no autonomous publish starts.
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(
      session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50,
    );
    await drainLane(session);
    expect(session.publishPause.isActive()).toBe(false);
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // Drive the publish explicitly → the OFF-lane pause (an editor must ack).
    const publishPromise = requestDocSessionPublish(SAMPLE_DOC_PATH);
    for (let i = 0; i < 50 && !session.publishPause.isActive(); i++) {
      await vi.advanceTimersByTimeAsync(1);
    }

    // Off-lane path: the pause is active and the proposal has NOT committed inline.
    // Ack the pause to drive the real editor-ack commit.
    await ackPauseAndCommit(session, EDITOR_SOCKET);
    await publishPromise;

    expect(session.generator.hasCurrentProposal()).toBe(false);

    // Both the early AND the later edit landed in canonical — the whole proposal
    // was published, not just the first-touched section.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain("new overview body");
    expect(await readSection(SAMPLE_DOC_PATH, ["Timeline"])).toContain("new timeline body");
    // Neither original body survives.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).not.toContain(SAMPLE_SECTIONS.overview);
    expect(await readSection(SAMPLE_DOC_PATH, ["Timeline"])).not.toContain(SAMPLE_SECTIONS.timeline);

    // The committed proposal's claim covers both edited sections.
    const committed = await readProposal(proposalId);
    expect(committed.status).toBe("committed");
    const claimedKeys = committed.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(claimedKeys).toContain(SectionRef.headingKey(["Overview"]));
    expect(claimedKeys).toContain(SectionRef.headingKey(["Timeline"]));
  });
});
