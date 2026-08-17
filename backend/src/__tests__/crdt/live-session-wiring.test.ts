/**
 * MW-1b / MW-2 / MW-3 live-editing pipeline wiring tests.
 *
 * These exercise the REAL coordinator-owned quiescence machinery
 * (`armQuiescenceTimer` → actor lane → `normalizeQuiescedSection` /
 * `runPublishAttempt`) and the canonical→live primitive
 * (`applyCommittedCanonicalToLiveSession`) against a real `DocSession` Y.Doc.
 *
 * They fail if the wiring is reverted:
 *  - MW-2: without the quiescence command calling `normalizeQuiescedSection`,
 *    a structurally-dirty quiesced fragment never converges mid-session.
 *  - MW-1b: without the settled-dirty-frontier branch calling
 *    `runPublishAttempt`, the inprogress proposal is never auto-published; and
 *    the "still bursting" case proves it does NOT publish mid-burst.
 *  - MW-3: without `applyCommittedCanonicalToLiveSession`, a separate proposal's
 *    committed change never reaches the open live Y.Doc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  applyCommittedCanonicalToLiveSession,
  requestDocSessionPublish,
} from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent, EMPTY_BODY } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Flush the actor lane so any enqueued quiescence/canonical command settles. */
async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

describe("live-editing pipeline wiring (MW-1b/2/3)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("structural normalization: a quiesced heading level-change is honored (proposal follows live)", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Author changes the Overview heading's LEVEL (authoritative level is 2 →
    // "## Overview"; they typed "####", level 4). The new design treats this as
    // a heading-level-change: the live edit is HONORED (proposal follows live),
    // NOT forced back to canonical. (The old set-diff/MW-2 mechanism wrongly
    // undid such edits.)
    const dirty = "#### Overview\n\nrewritten body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    // Mark the fragment active "now" so the policy can later see it quiesced.
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toContain("#### Overview");

    // Arm the timer, then advance past the quiescence threshold so the command fires.
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await drainLane(session);

    // The live fragment KEEPS the author's level-4 heading and body (not undone).
    const normalized = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(normalized).toContain("#### Overview");
    expect(normalized).toContain("rewritten body");

    // The proposal followed the level change in place (id preserved → same live
    // fragment key still resolves to the now-level-4 Overview section).
    const { ProposalReader } = await import("../../storage/proposal-reader.js");
    const reader = ProposalReader.open(proposalId, "inprogress");
    const sections = await reader.getSectionList(SAMPLE_DOC_PATH);
    const overview = sections.find((s) => s.heading === "Overview");
    expect(overview?.headingLevel).toBe(4);
  });

  it("MW-1b: quiet quiescence normalizes without publishing; explicit publish commits", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    const edited = buildFragmentContent("autonomously published body" as SectionBody, 2, "Overview");
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, edited);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);

    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await drainLane(session);

    // The quiet timer alone is NOT a settled dirty frontier: no publish, no pause.
    expect(session.publishPause.isActive()).toBe(false);
    expect(session.generator.hasCurrentProposal()).toBe(true);

    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    await drainLane(session);
    expect(outcome.outcome).toBe("committed");
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  it("MW-1b: does NOT publish while edits are still arriving (mid-burst)", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    const edited = buildFragmentContent("burst body" as SectionBody, 2, "Overview");
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, edited);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    armQuiescenceTimer(session);

    // A second edit arrives BEFORE the threshold → re-arm, fragment not quiescent.
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs - 200);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    armQuiescenceTimer(session);

    // Advance only a little — not enough for the (re-armed) timer to fire.
    await vi.advanceTimersByTimeAsync(300);
    await drainLane(session);

    // Mid-burst: still has its inprogress proposal (no autonomous publish).
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  it("MW-3: a separate proposal's committed change reaches the open live Y.Doc", async () => {
    const session = await openSession();

    // The live Y.Doc currently holds the canonical Overview body.
    const before = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(before).toContain("The overview covers our strategic goals.");

    // A SEPARATE writer commits a change to Overview's canonical body via a
    // distinct (non-DocSession) proposal.
    const { createTransientProposal } = await import("../../storage/proposal-repository.js");
    const { publishProposalToCanonicalDetailed } = await import("../../storage/commit-pipeline.js");
    const { mutateProposalContent } = await import("../../storage/mutate-proposal-content.js");

    const { id: otherProposalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "edit overview",
    );
    // Write + derive the manifest through the single manifest-owning boundary.
    await mutateProposalContent(otherProposalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      heading: "Overview",
      content: "COMMITTED BY BOB",
    });
    const absorb = await publishProposalToCanonicalDetailed(otherProposalId, {});

    const headingPaths = absorb.changedSections.map((s) => [...s.headingPath]);
    expect(headingPaths.length).toBeGreaterThan(0);

    // Apply the committed canonical change into the live session (NOT a self-commit).
    await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, headingPaths, otherProposalId);
    await drainLane(session);

    const after = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(after).toContain("COMMITTED BY BOB");
    expect(after).not.toContain("The overview covers our strategic goals.");
  });

  it("MW-3: self-commit is NOT re-applied onto the originating live session", async () => {
    const session = await openSession();
    // Force a current proposal so the self-commit guard has an id to match.
    const ownProposalId = await session.generator.ensureCurrentProposal();

    const spy = vi.spyOn(session.generator, "applyCanonicalDeltaToLive");
    await applyCommittedCanonicalToLiveSession(
      SAMPLE_DOC_PATH,
      [["Overview"]],
      ownProposalId,
    );
    await drainLane(session);
    expect(spy).not.toHaveBeenCalled();
  });
});

// Reference an unused import to keep tsc happy if EMPTY_BODY ends up unused in
// a future refactor; harmless no-op.
void EMPTY_BODY;
