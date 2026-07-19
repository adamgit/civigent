/**
 * Runtime publish-failure behavior (spec 10 §15 "Publish failure handling").
 *
 * Spec: "If the publish attempt aborts … keep the existing `inprogress` proposal
 * as the current proposal and resume editing. The system must never create a
 * second live proposal to work around a failed publish."
 *
 * A process-alive runtime failure is injected at the canonical-absorb step (the
 * same seam the commit-pipeline tests drive). This is a RUNTIME failure — the
 * process stays up — not a crash, so the FSM rollback path (not crash recovery)
 * is what must keep the proposal as the DocSession's live proposal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer, requestDocSessionPublish } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readProposal, listInProgressProposals } from "../../storage/proposal-repository.js";
import { readSection } from "../../storage/section-reader.js";
import { CanonicalStore } from "../../storage/canonical-store.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

function editOverview(session: Awaited<ReturnType<typeof openSession>>, body: string) {
  session.liveFragments.replaceFragmentString(
    OVERVIEW_KEY,
    buildFragmentContent(body as SectionBody, 2, "Overview"),
  );
  session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
}

async function quiesce(session: Awaited<ReturnType<typeof openSession>>) {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(
    session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50,
  );
  await drainLane(session);
}

describe("autonomous publish runtime failure (spec 10 §Publish failure handling)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("returns the proposal to inprogress (not draft/committing) on a runtime commit failure, and a following edit reuses it", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    editOverview(session, "edit that fails to publish");
    const proposalId = await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // Inject a process-alive runtime failure at the canonical-absorb step.
    const absorbSpy = vi
      .spyOn(CanonicalStore.prototype, "absorbChangedSections")
      .mockRejectedValue(new Error("disk on fire during absorb"));

    // The quiet timer normalizes only — no autonomous publish, so the failure
    // is driven through the explicit publish path.
    await quiesce(session);
    expect(session.publishPause.isActive()).toBe(false);
    expect(absorbSpy).not.toHaveBeenCalled();

    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    await drainLane(session);
    expect(outcome.outcome).toBe("failed");
    expect(absorbSpy).toHaveBeenCalled();

    // Returned to inprogress — NOT draft, NOT stuck in committing.
    expect((await readProposal(proposalId)).status).toBe("inprogress");
    // Still the DocSession's current proposal (kept, not discarded).
    expect(session.generator.hasCurrentProposal()).toBe(true);
    expect(session.generator.getCurrentProposalId()).toBe(proposalId);
    // Canonical untouched — nothing was published.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);

    // A following edit must NOT silently create a second live proposal: it
    // materializes into the SAME proposal, and exactly one inprogress proposal
    // exists for this DocSession.
    absorbSpy.mockRestore();
    editOverview(session, "a follow-up edit after the failed publish");
    const afterFailureId = await session.generator.materializeEdit();
    expect(afterFailureId).toBe(proposalId);

    const inProgressForSession = (await listInProgressProposals()).filter(
      (p) => p.proposalAdoptionId === session.generator.proposalAdoptionId,
    );
    expect(inProgressForSession).toHaveLength(1);
    expect(inProgressForSession[0]!.id).toBe(proposalId);
  });
});
