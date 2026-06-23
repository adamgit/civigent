/**
 * Settled-dirty-frontier publish gating (spec 10 §15 "Default publish-trigger
 * policy", rule 3).
 *
 * The spec enumerates the activities that make a dirty frontier UNsettled —
 * "no paste, drop, undo/redo burst, IME composition, programmatic editor
 * command, or structural normalization is currently in progress" and "no section
 * topology change … still being normalized", "collaborators are not actively
 * mutating the same changed section-set" — versus the read-only activities that
 * do NOT block publish: "users … are only viewing, scrolling, selecting, copying,
 * or rereading it without generating content-changing Yjs transactions".
 *
 * These tests drive the REAL generator decision (`evaluatePublishTrigger`, which
 * folds in the generator's own `hasCurrentProposal`) for each distinct activity,
 * rather than a single timer/focus proxy. They assert BOTH the decision and the
 * firing rule, and crucially contrast mutating-in-progress activity (blocks) with
 * read-only activity (publishes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import type { PublishTriggerSignals } from "../../crdt/crdt-proposal-generator.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

type FrontierSignals = Omit<PublishTriggerSignals, "hasCurrentProposal">;

/** A fully-settled dirty frontier: every gating signal satisfied. */
function settledFrontier(): FrontierSignals {
  return {
    forcedCanonicalOperation: false,
    lastEditorLeft: false,
    allInboundUpdatesProcessed: true,
    noBurstOrCompositionInProgress: true,
    noTopologyChangeInFlight: true,
    usersLeftChangedSections: true,
    noCollaboratorMutatingChangedSet: true,
  };
}

async function openSessionWithProposal(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
  // Materialize one edit so the generator has a current proposal (rule 3 only
  // applies when there is something to publish).
  session.liveFragments.replaceFragmentString(
    OVERVIEW_KEY,
    buildFragmentContent("a dirty edit" as SectionBody, 2, "Overview"),
  );
  session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
  await session.generator.materializeEdit();
  expect(session.generator.hasCurrentProposal()).toBe(true);
  return session;
}

describe("settled-dirty-frontier publish gating (spec 10 §Default publish-trigger policy rule 3)", () => {
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

  // ── Mutating / in-progress activity: each keeps the frontier UNsettled. ──
  const blockingActivities: Array<{ activity: string; override: Partial<FrontierSignals> }> = [
    { activity: "an undo/redo burst is in progress", override: { noBurstOrCompositionInProgress: false } },
    { activity: "an IME composition is in progress", override: { noBurstOrCompositionInProgress: false } },
    { activity: "a programmatic editor command is in progress", override: { noBurstOrCompositionInProgress: false } },
    { activity: "structural normalization is in progress", override: { noTopologyChangeInFlight: false } },
    { activity: "a section topology change is still being normalized", override: { noTopologyChangeInFlight: false } },
    { activity: "a collaborator is actively mutating the changed set", override: { noCollaboratorMutatingChangedSet: false } },
    { activity: "earlier inbound Yjs updates have not all reached the actor", override: { allInboundUpdatesProcessed: false } },
  ];

  for (const { activity, override } of blockingActivities) {
    it(`does NOT publish while ${activity}`, async () => {
      const session = await openSessionWithProposal();
      const decision = session.generator.evaluatePublishTrigger({ ...settledFrontier(), ...override });
      expect(decision.shouldPublish).toBe(false);
      expect(decision.rule).toBe("none");
    });
  }

  // ── Read-only activity does NOT gate publish. Viewing, scrolling, selecting,
  //    copying, and rereading generate NO content-changing Yjs transaction, so
  //    they flip none of the gating signals — the frontier stays settled and the
  //    proposal publishes. (These activities live in the frontend and never reach
  //    the backend as a publish-trigger signal, which is exactly why a settled
  //    frontier must publish through them.) ──
  it("publishes through read-only activity (viewing/scrolling/selecting/copying/rereading)", async () => {
    const session = await openSessionWithProposal();
    // A settled frontier — the state during pure read-only activity.
    const decision = session.generator.evaluatePublishTrigger(settledFrontier());
    expect(decision.shouldPublish).toBe(true);
    expect(decision.rule).toBe("settled-dirty-frontier");
  });

  it("does not publish a read-only frontier that has no current proposal (zero-edit viewing session)", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
    // No edit → no proposal. Pure viewing must never publish.
    const decision = session.generator.evaluatePublishTrigger(settledFrontier());
    expect(decision.shouldPublish).toBe(false);
    expect(decision.rule).toBe("none");
  });
});
