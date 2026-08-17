/**
 * INTERACTION (live/CRDT path): a subsection deleted by a live edit must stay
 * deleted when its ANCESTOR is later re-pathed live (rename) — it must NOT be
 * resurrected on reseed or publish.
 *
 * This drives the real live pipeline so it exercises the CRDT structural
 * reflections that record/remap delete-claims (`reflectMergeIntoProposal`,
 * `reflectHeadingEditIntoProposal` in `crdt/structural-appliers.ts`) against the
 * manifest-overlay merge's path-based delete detection. The agent path is covered
 * in `storage/delete-survives-ancestor-restructure.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import {
  armQuiescenceTimer,
  registerFakeEditorSocketForTest,
  resetCoordinatorPublishStateForTest,
} from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";
import { fireLiveMove } from "../helpers/crdt-session.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function openSession(): Promise<DocSession> {
  const { getHeadSha } = await import("../../storage/git-repo.js");
  const { getDataRoot } = await import("../../storage/data-root.js");
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

async function liveKeys(session: DocSession): Promise<string[]> {
  const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, session.generator.getCurrentProposalId());
  return layout.map((e) => e.headingPath.join(">>"));
}

async function nestSubUnderOverview(): Promise<void> {
  const { id } = await createTransientProposal(WRITER, "nest Sub under Overview");
  await mutateProposalContent(id, {
    kind: "create_section",
    docPath: SAMPLE_DOC_PATH,
    headingPath: ["Overview", "Sub"],
    heading: "Sub",
    content: "original sub body",
  });
  await publishProposalToCanonicalDetailed(id, {});
}

describe("live delete of a subsection survives an ancestor rename (CRDT path)", () => {
  let ctx: TempDataRootContext;
  let editorSock: { dispose: () => void } | null = null;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    await nestSubUnderOverview(); // canonical: Overview > Sub, Timeline
  });

  afterEach(async () => {
    editorSock?.dispose();
    editorSock = null;
    resetCoordinatorPublishStateForTest();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("delete Overview›Sub live, then rename Overview live → Sub stays deleted after reseed", async () => {
    vi.useFakeTimers();
    let session = await openSession();
    editorSock = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");

    // Resolve the seeded fragment keys for Sub and the Overview body-holder.
    const seeded = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, null);
    const subKey = seeded.find((e) => e.headingPath.join(">>") === "Overview>>Sub")!.fragmentKey;
    const overviewKey = seeded.find((e) => e.headingPath.join(">>") === "Overview")!.fragmentKey;

    // 1) Live-delete Sub: strip its heading → heading-deletion merges it away.
    session.liveFragments.replaceFragmentString(subKey, "orphaned sub body, no heading" as FragmentContent);
    session.fragmentLastActivity.set(subKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [subKey] });
    await fireQuiescence(session);
    expect(await liveKeys(session)).not.toContain("Overview>>Sub"); // gone now

    // 2) Live-rename the ancestor Overview → "Overview Renamed".
    session.liveFragments.replaceFragmentString(
      overviewKey,
      "## Overview Renamed\n\noverview body" as FragmentContent,
    );
    session.fragmentLastActivity.set(overviewKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [overviewKey] });
    await fireQuiescence(session);
    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).not.toBeNull();

    // 3) Reseed: discard + reconstruct (adopts the same inprogress proposal).
    editorSock.dispose();
    editorSock = null;
    destroyAllSessions();
    vi.useRealTimers();
    session = await openSession();
    expect(session.generator.getCurrentProposalId()).toBe(proposalId);

    // The renamed ancestor is live; the deleted Sub must NOT be resurrected at the
    // old OR the new ancestor path.
    const keys = await liveKeys(session);
    expect(keys).toContain("Overview Renamed");
    expect(keys).not.toContain("Overview>>Sub");
    expect(keys).not.toContain("Overview Renamed>>Sub");
  });

  it("delete Overview›Sub live, then live cross-section-MOVE Overview → Sub stays deleted after reseed AND publish", async () => {
    vi.useFakeTimers();
    let session = await openSession();
    editorSock = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "editor-sock");

    // Resolve the seeded fragment key for Sub.
    const seeded = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, null);
    const subKey = seeded.find((e) => e.headingPath.join(">>") === "Overview>>Sub")!.fragmentKey;

    // 1) Live-delete Sub: strip its heading → heading-deletion merges it away.
    session.liveFragments.replaceFragmentString(subKey, "orphaned sub body, no heading" as FragmentContent);
    session.fragmentLastActivity.set(subKey, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [subKey] });
    await fireQuiescence(session);
    expect(await liveKeys(session)).not.toContain("Overview>>Sub"); // gone now

    // The quiescence cycle fired an autonomous publish attempt that, with a live
    // editor socket present, parks in a publish-pause waiting for a readiness ack.
    // None arrives in this unit test; advance past the readiness timeout so the
    // attempt aborts and releases the pause WITHOUT committing — the delete stays
    // staged in the still-inprogress proposal, ready to move within.
    await vi.advanceTimersByTimeAsync(11_000);
    await drainLane(session);
    expect(session.publishPause.isActive()).toBe(false);
    expect(session.generator.getCurrentProposalId()).not.toBeNull();

    // 2) Live cross-section MOVE: reorder the deleted Sub's ancestor (Overview)
    //    across to sit after its sibling Timeline. This drives the real
    //    `requestDocSessionMove` → `moveLiveSection` path, which re-seeds the
    //    live fragments from the proposal layout — the moment a stale delete
    //    could be lost and Sub re-inherited from canonical.
    const moveResult = await fireLiveMove(session, {
      sourceHeadingPath: ["Overview"],
      targetHeadingPath: ["Timeline"],
      position: "after",
    });
    expect(moveResult.ok, moveResult.message).toBe(true);

    const afterMove = await liveKeys(session);
    expect(afterMove).toContain("Overview");
    expect(afterMove).toContain("Timeline");
    expect(afterMove).not.toContain("Overview>>Sub");
    expect(afterMove).not.toContain("Timeline>>Sub");

    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).not.toBeNull();

    // 3) Reseed: discard + reconstruct (adopts the same inprogress proposal).
    editorSock.dispose();
    editorSock = null;
    destroyAllSessions();
    vi.useRealTimers();
    session = await openSession();
    expect(session.generator.getCurrentProposalId()).toBe(proposalId);

    // The moved ancestor is live; Sub must NOT be resurrected at the old OR the
    // new ancestor path on reseed.
    const reseeded = await liveKeys(session);
    expect(reseeded).toContain("Overview");
    expect(reseeded).toContain("Timeline");
    expect(reseeded).not.toContain("Overview>>Sub");
    expect(reseeded).not.toContain("Timeline>>Sub");

    // 4) Publish. Canonical must reflect the deletion: no Sub section anywhere.
    const result = await session.generator.finalizeAndPublish();
    expect(result.status).toBe("committed");

    const canonical = await new ContentLayer(getContentRoot()).readAllSections(SAMPLE_DOC_PATH);
    expect(canonical.has(SectionRef.headingKey(["Overview"]))).toBe(true);
    expect(canonical.has(SectionRef.headingKey(["Timeline"]))).toBe(true);
    expect(canonical.has(SectionRef.headingKey(["Overview", "Sub"]))).toBe(false);
    expect(canonical.has(SectionRef.headingKey(["Timeline", "Sub"]))).toBe(false);
  });
});
