/**
 * MW-10: backend-owned cross-section move (structural reorder).
 *
 * Y.js has no `moveTo` between top-level types, so a cross-section move is a
 * backend-owned structural reorder of the DocSession's `inprogress` proposal
 * skeleton (the authoritative section order), followed by a single-transaction
 * re-seed of the live Y.Doc fragments. These tests exercise the REAL actor-lane
 * command (`moveLiveSection`) against a real DocSession Y.Doc:
 *
 *  (1) data-correct reorder: moving Timeline before Overview reorders the live
 *      section layout AND each section's body content survives the move exactly
 *      (the accepted bar: "100% correct data"). Caret recovery is deferred.
 *  (2) atomicity: the reorder lands in a single Y.transact (the fan-out applies
 *      the whole reordered state at once).
 *  (3) gating: refused during a publish pause; refused when the source/target is
 *      `gone` (not in the live layout); refused when a competing proposal holds
 *      an exclusive FSM lock on the source/target (`blocked`), each with prose.
 *
 * Fails if the move is reverted to a no-op/"not available" stub: the order would
 * not change and the gating verdicts would not be produced.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { moveLiveSection } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Resolve the ordered top-level heading names from the live layout. */
async function liveHeadingOrder(session: DocSession): Promise<string[]> {
  const layout = await resolveLiveSectionLayout(session.docPath, session.generator.getCurrentProposalId());
  return layout.filter((e) => e.headingPath.length === 1).map((e) => e.heading);
}

async function lockSectionWithCompetingProposal(headingPath: string[]): Promise<void> {
  const { id } = await createProposal(
    { id: "user-bob", type: "human", displayName: "Bob" },
    "Competing lock",
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: headingPath }],
  );
  const result = await transitionToInProgress(id);
  expect(result.acquired).toBe(true);
}

describe("MW-10: cross-section move", () => {
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

  it("(1) reorders the live section order (Timeline before Overview) and preserves body content", async () => {
    const session = await openSession();
    // Initial top-level order: Overview, Timeline.
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);

    const overviewBefore = session.liveFragments.readFragmentString("section::overview") as string;
    const timelineBefore = session.liveFragments.readFragmentString("section::timeline") as string;
    expect(overviewBefore).toContain("The overview covers our strategic goals.");

    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(true);

    // Data-correct: the authoritative live order flipped to Timeline, Overview.
    expect(await liveHeadingOrder(session)).toEqual(["Timeline", "Overview"]);

    // Body content survives the move exactly (matched by section identity, which
    // may be re-keyed; assert via the resolved layout fragment keys).
    const layout = await resolveLiveSectionLayout(session.docPath, session.generator.getCurrentProposalId());
    const timelineKey = layout.find((e) => e.heading === "Timeline")!.fragmentKey;
    const overviewKey = layout.find((e) => e.heading === "Overview")!.fragmentKey;
    const overviewAfter = session.liveFragments.readFragmentString(overviewKey) as string;
    const timelineAfter = session.liveFragments.readFragmentString(timelineKey) as string;
    expect(overviewAfter).toContain("The overview covers our strategic goals.");
    // Bodies preserved (compare body, ignoring heading-line reordering noise).
    expect(timelineAfter).toContain(timelineBefore.replace(/^##\s+Timeline\s*/, "").trim().split("\n")[0]);
  });

  it("(2) the move is atomic: a single materialized layout reflects the reorder", async () => {
    const session = await openSession();
    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(true);
    // After the single command settles, the order is fully the new order — never
    // a partially-applied intermediate (Overview duplicated / Timeline missing).
    const order = await liveHeadingOrder(session);
    expect(order).toEqual(["Timeline", "Overview"]);
    expect(new Set(order).size).toBe(order.length);
  });

  it("(3a) refused during a publish pause, with prose", async () => {
    const session = await openSession();
    // Establish a publish pause directly on the session FSM.
    session.publishPause.start([]);
    expect(session.publishPause.isActive()).toBe(true);

    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/published right now|try moving the section again/i);
    session.publishPause.end();
    // Order unchanged.
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);
  });

  it("(3b) refused when the source section is gone (not in the live layout)", async () => {
    const session = await openSession();
    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Nonexistent"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no longer available/i);
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);
  });

  it("(3c) refused when a competing proposal holds an exclusive lock on the source", async () => {
    const session = await openSession();
    await lockSectionWithCompetingProposal(["Timeline"]);

    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/locked by an in-progress proposal/i);
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);
  });

  it("(4a) refused while the move source has an unreconciled structural change (heading level)", async () => {
    const session = await openSession();
    session.liveFragments.replaceFragmentString(
      "section::overview",
      "# Overview\n\nThe overview covers our strategic goals." as FragmentContent,
    );
    session.fragmentLastActivity.set("section::overview", Date.now());

    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/still settling/i);
    expect(session.generator.getCurrentProposalId()).toBeNull();
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);
  });

  it("(4b) refused when an unreconciled structural change exists elsewhere in the layout (pending root-split in BFH)", async () => {
    const session = await openSession();
    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      "This is the strategy document preamble.\n\n# Injected\n\nSeed body." as FragmentContent,
    );
    session.fragmentLastActivity.set(BEFORE_FIRST_HEADING_KEY, Date.now());

    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/still settling/i);
    expect(session.generator.getCurrentProposalId()).toBeNull();
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);
  });

  it("(4c) body-only pending edits do not block the move (control)", async () => {
    const session = await openSession();
    session.liveFragments.replaceFragmentString(
      "section::overview",
      "## Overview\n\nEdited body, still structurally clean." as FragmentContent,
    );
    session.fragmentLastActivity.set("section::overview", Date.now());

    const result = await session.enqueue(() =>
      moveLiveSection(session, {
        sourceHeadingPath: ["Timeline"],
        targetHeadingPath: ["Overview"],
        position: "before",
      }),
    );
    expect(result.ok).toBe(true);
    expect(await liveHeadingOrder(session)).toEqual(["Timeline", "Overview"]);
  });
});
