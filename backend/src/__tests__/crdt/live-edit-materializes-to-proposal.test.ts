/**
 * Live CRDT edits materialize into PROPOSAL CONTENT while CANONICAL content
 * stays unchanged until publish (spec 05 §Session Persistence / §Proposal
 * Publication; spec 10 §One active proposal per DocSession).
 *
 * "Durability flows through `ProposalEditor` over `DocumentSkeleton`" — the
 * in-flight `inprogress` proposal content tree carries the live activity, and a
 * separate process could read it back from disk. The canonical store is NOT
 * touched until a publish commits.
 *
 * The assertions read the proposal body through the `ProposalReader` facade
 * (durable, on-disk proposal content) and the canonical body through
 * `readSection` — NOT the in-memory Y.Doc — so a regression that only updated the
 * live Y.Doc without materializing to the proposal tree would FAIL this test.
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
import { readSection } from "../../storage/section-reader.js";
import { ProposalReader } from "../../storage/proposal-reader.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

describe("live edits materialize into proposal content; canonical unchanged until publish", () => {
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

  it("materializes the edit into the inprogress proposal tree while canonical stays at the pre-edit body", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("live drafted overview" as SectionBody, 2, "Overview"),
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    // The DURABLE inprogress proposal content (on disk, via the reader facade)
    // already holds the live edit.
    const proposalBody = await ProposalReader.open(proposalId, "inprogress").readEffectiveSection(
      SAMPLE_DOC_PATH,
      ["Overview"],
    );
    expect(proposalBody).toContain("live drafted overview");

    // Canonical is UNCHANGED — the edit has not been published.
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);

    // Quiesce — normalization only; canonical still unchanged (no autonomous publish).
    armQuiescenceTimer(session);
    await vi.advanceTimersByTimeAsync(
      session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50,
    );
    await drainLane(session);
    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toBe(SAMPLE_SECTIONS.overview);

    // Publish explicitly — only now does canonical absorb the live edit.
    const outcome = await requestDocSessionPublish(SAMPLE_DOC_PATH);
    await drainLane(session);
    expect(outcome.outcome).toBe("committed");

    expect(await readSection(SAMPLE_DOC_PATH, ["Overview"])).toContain("live drafted overview");
  });
});
