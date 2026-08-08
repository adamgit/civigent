import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DocSessionPublishPause } from "../../crdt/docsession-publish-pause.js";
import {
  CRDTProposalGenerator,
  type LiveDocumentSource,
} from "../../crdt/crdt-proposal-generator.js";
import {
  findInProgressProposalByAdoptionId,
  listInProgressProposals,
  locateProposalContentRoot,
} from "../../storage/proposal-repository.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { ProposalAdoptionId, type WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = { id: "user-alice", type: "human", displayName: "Alice" };

function source(): LiveDocumentSource {
  return {
    partitionLiveFragmentsByStructuralCleanliness: () => ({
      materializableBodies: [
        { headingPath: ["Intro"], heading: "Intro", level: 1, body: "content", fragmentKey: "section::intro" },
      ],
      awaitingStructuralReconciliation: [],
    }),
  };
}

describe("DocSessionPublishPause FSM", () => {
  it("resolves ready once every required socket acks (ordered readiness)", async () => {
    const pause = new DocSessionPublishPause({ readinessTimeoutMs: 1000 });
    const waiter = pause.start(["sock-1", "sock-2"]);
    expect(pause.getState()).toBe("pausing");
    expect(pause.pendingSockets().sort()).toEqual(["sock-1", "sock-2"]);

    pause.markReady("sock-1");
    expect(pause.getState()).toBe("pausing");
    expect(pause.pendingSockets()).toEqual(["sock-2"]);

    pause.markReady("sock-2");
    const result = await waiter;
    expect(result.outcome).toBe("ready");
    expect(pause.getState()).toBe("ready");
  });

  it("resolves ready immediately when there are no active editor sockets", async () => {
    const pause = new DocSessionPublishPause();
    const result = await pause.start([]);
    expect(result.outcome).toBe("ready");
    expect(result.reason).toBe("no-active-editors");
  });

  it("aborts on readiness timeout", async () => {
    vi.useFakeTimers();
    try {
      const pause = new DocSessionPublishPause({ readinessTimeoutMs: 5000 });
      const waiter = pause.start(["sock-1"]);
      vi.advanceTimersByTime(5000);
      const result = await waiter;
      expect(result.outcome).toBe("aborted");
      expect(result.reason).toBe("timeout");
      expect(pause.getState()).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts when a required, unacked socket disconnects (no in-flight publish)", async () => {
    const pause = new DocSessionPublishPause({ readinessTimeoutMs: 1000 });
    const waiter = pause.start(["sock-1", "sock-2"]);
    pause.markReady("sock-1");
    pause.handleSocketDisconnect("sock-2");
    const result = await waiter;
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toBe("socket-disconnected");
  });

  it("ignores acks/disconnects for non-required (late-joining frozen) sockets", async () => {
    const pause = new DocSessionPublishPause({ readinessTimeoutMs: 1000 });
    const waiter = pause.start(["sock-1"]);
    pause.markReady("late-socket"); // joined after pause started → ignored
    pause.handleSocketDisconnect("late-socket");
    expect(pause.getState()).toBe("pausing");
    pause.markReady("sock-1");
    const result = await waiter;
    expect(result.outcome).toBe("ready");
  });

  it("end() resets to idle so the next attempt can start", async () => {
    const pause = new DocSessionPublishPause();
    await pause.start([]);
    pause.end();
    expect(pause.getState()).toBe("idle");
    // can start again
    const second = await pause.start([]);
    expect(second.outcome).toBe("ready");
  });
});

describe("CRDTProposalGenerator publish (final materialization + commit)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("commit success clears the current-proposal reference", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source: source(),
    });

    await gen.materializeEdit();
    expect(gen.hasCurrentProposal()).toBe(true);

    const result = await gen.finalizeAndPublish();
    expect(result.status).toBe("committed");
    expect(result.commitSha).toBeTruthy();
    expect(gen.getCurrentProposalId()).toBeNull();

    // No inprogress proposal remains for the session (it advanced to committed).
    const remaining = await findInProgressProposalByAdoptionId(proposalAdoptionId);
    expect(remaining).toBeNull();
  });

  it("finalizeAndPublish is a no-op when there is no current proposal", async () => {
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId: ProposalAdoptionId.create(),
      writer,
      source: source(),
    });
    const result = await gen.finalizeAndPublish();
    expect(result.status).toBe("noop-no-proposal");
  });

  it("commit failure returns the proposal to inprogress and keeps it as current", async () => {
    const proposalAdoptionId = ProposalAdoptionId.create();
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId,
      writer,
      source: source(),
    });
    const proposalId = await gen.materializeEdit();

    // Force the canonical commit to fail by corrupting the committing content
    // root mid-flight is hard to schedule; instead spy on the commit pipeline.
    const pipeline = await import("../../storage/commit-pipeline.js");
    const spy = vi
      .spyOn(pipeline, "commitProposalToCanonicalDetailed")
      .mockRejectedValueOnce(new Error("simulated canonical commit failure"));

    // Re-import the generator module is not needed; finalizeAndPublish calls the
    // pipeline via the same module binding the spy patched.
    let result;
    try {
      result = await gen.finalizeAndPublish();
    } finally {
      spy.mockRestore();
    }

    expect(result.status).toBe("failed-returned-to-inprogress");
    expect(result.proposalId).toBe(proposalId);
    // Generator keeps the same proposal as current (spec 10 §Publish failure).
    expect(gen.getCurrentProposalId()).toBe(proposalId);
    // The proposal is back at inprogress (not draft, not committing).
    const stillInProgress = await findInProgressProposalByAdoptionId(proposalAdoptionId);
    expect(stillInProgress).not.toBeNull();
    expect(stillInProgress!.id).toBe(proposalId);
    // its content root is the inprogress location
    const root = await locateProposalContentRoot(proposalId);
    expect(root).toContain("inprogress");
  });

  it("evaluatePublishTrigger applies the rule-ordered policy", async () => {
    const gen = new CRDTProposalGenerator({
      docPath: "/guide.md",
      proposalAdoptionId: ProposalAdoptionId.create(),
      writer,
      source: source(),
    });

    const settledSignals = {
      forcedCanonicalOperation: false,
      lastEditorLeft: false,
      allInboundUpdatesProcessed: true,
      noBurstOrCompositionInProgress: true,
      noTopologyChangeInFlight: true,
      usersLeftChangedSections: true,
      noCollaboratorMutatingChangedSet: true,
    };

    // No current proposal yet → nothing to publish (except forced op).
    expect(gen.evaluatePublishTrigger(settledSignals).shouldPublish).toBe(false);
    expect(
      gen.evaluatePublishTrigger({ ...settledSignals, forcedCanonicalOperation: true }).rule,
    ).toBe("forced-canonical-op");

    await gen.materializeEdit();

    // Last editor leaves (rule 2) beats settled-frontier (rule 3).
    expect(
      gen.evaluatePublishTrigger({ ...settledSignals, lastEditorLeft: true }).rule,
    ).toBe("last-editor-left");

    // Settled frontier (rule 3).
    expect(gen.evaluatePublishTrigger(settledSignals).rule).toBe("settled-dirty-frontier");

    // Not settled (an inbound update still unprocessed) → must remain inprogress.
    expect(
      gen.evaluatePublishTrigger({ ...settledSignals, allInboundUpdatesProcessed: false })
        .shouldPublish,
    ).toBe(false);
  });
});
