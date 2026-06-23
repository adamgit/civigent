/**
 * Live-edit race ORDERING against competing proposal locks (spec 01
 * §CRDTProposalGenerator "Race arbitration"; spec 12 §Proposal FSM locking).
 *
 * The single-section blocked/win/self-exclusion cases are covered in
 * `docsession-race-arbitration.test.ts`. THIS file pins the harder observable
 * outcomes that prove ordering/partial arbitration is correct:
 *
 *  (1) Mixed update: ONE inbound client update touches a FREE section and a
 *      COMPETING-LOCKED section together. The free section must win
 *      (materialized, content kept), the locked section must lose (reverted,
 *      `section:blocked` emitted), and the DocSession proposal must claim ONLY
 *      the won section.
 *  (2) Ordering across the lane: a lock acquired BETWEEN two serialized edits
 *      flips the outcome — the earlier edit (pre-lock) wins and stays, the later
 *      edit to the now-locked section is blocked. The earlier won content is not
 *      clobbered by the later refusal.
 *
 * All assertions are on the OBSERVABLE surface (live fragment content, emitted
 * `section:blocked` events, the proposal's claimed sections) — never on private
 * actor/queue internals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { processArbitratedClientUpdate, setCrdtEventHandler } from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal, transitionToInProgress, readProposal } from "../../storage/proposal-repository.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Build a real client Yjs diff update that rewrites the given fragments. */
function buildClientUpdate(session: DocSession, edits: Record<string, FragmentContent>): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  for (const [key, content] of Object.entries(edits)) {
    tempStore.replaceFragmentString(key, content);
  }
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

async function lockSection(headingPath: string[]): Promise<string> {
  const { id } = await createProposal(
    { id: "user-bob", type: "human", displayName: "Bob" },
    "Competing lock",
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: headingPath }],
  );
  const result = await transitionToInProgress(id);
  expect(result.acquired).toBe(true);
  return id;
}

describe("live-edit race ordering against competing locks", () => {
  let ctx: TempDataRootContext;
  let events: WsServerEvent[];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    events = [];
    setCrdtEventHandler((e) => events.push(e));
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("(1) mixed update: free section wins, competing-locked section reverts, only the won section is claimed", async () => {
    const session = await openSession();
    await lockSection(["Timeline"]); // Timeline is exclusively held by a competing proposal.

    const update = buildClientUpdate(session, {
      [OVERVIEW_KEY]: buildFragmentContent("alice edits free overview" as SectionBody, 2, "Overview"),
      [TIMELINE_KEY]: buildFragmentContent("alice tries to edit locked timeline" as SectionBody, 2, "Timeline"),
    });

    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // Overview (free) won and is materialized; Timeline (locked) reverted.
    const overviewAfter = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    const timelineAfter = session.liveFragments.readFragmentString(TIMELINE_KEY) as string;
    expect(overviewAfter).toContain("alice edits free overview");
    expect(timelineAfter).not.toContain("alice tries to edit locked timeline");
    expect(timelineAfter).toContain("Q1: Planning. Q2: Execution. Q3: Review.");

    // section:blocked emitted for Timeline ONLY (not Overview).
    const blockedKeys = events
      .filter((e) => e.type === "section:blocked")
      .map((e) => (e as { fragment_key: string }).fragment_key);
    expect(blockedKeys).toContain(TIMELINE_KEY);
    expect(blockedKeys).not.toContain(OVERVIEW_KEY);

    // The DocSession proposal claims ONLY the won section (Overview), never the
    // blocked Timeline.
    expect(session.generator.hasCurrentProposal()).toBe(true);
    const proposal = await readProposal(session.generator.getCurrentProposalId()!);
    const claimed = proposal.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(claimed).toContain(SectionRef.headingKey(["Overview"]));
    expect(claimed).not.toContain(SectionRef.headingKey(["Timeline"]));
  });

  it("(2) ordering: a lock taken between two edits blocks only the later edit; the earlier won edit survives", async () => {
    const session = await openSession();

    // Edit 1 (pre-lock): freely edit Timeline — it wins.
    await session.enqueue(() =>
      processArbitratedClientUpdate(
        session,
        WRITER.id,
        buildClientUpdate(session, {
          [TIMELINE_KEY]: buildFragmentContent("timeline won before any lock" as SectionBody, 2, "Timeline"),
        }),
      ),
    );
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY) as string).toContain(
      "timeline won before any lock",
    );
    events.length = 0;

    // A competing proposal now locks Overview (a section Alice has NOT yet touched).
    await lockSection(["Overview"]);

    // Edit 2 (post-lock): try to edit the now-locked Overview — it must be blocked.
    await session.enqueue(() =>
      processArbitratedClientUpdate(
        session,
        WRITER.id,
        buildClientUpdate(session, {
          [OVERVIEW_KEY]: buildFragmentContent("alice tries overview after lock" as SectionBody, 2, "Overview"),
        }),
      ),
    );

    // Overview reverted + blocked; the earlier Timeline win is untouched.
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).not.toContain(
      "alice tries overview after lock",
    );
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY) as string).toContain(
      "timeline won before any lock",
    );
    const blockedKeys = events
      .filter((e) => e.type === "section:blocked")
      .map((e) => (e as { fragment_key: string }).fragment_key);
    expect(blockedKeys).toEqual([OVERVIEW_KEY]);

    // The proposal still claims the earlier won Timeline and never the blocked Overview.
    const proposal = await readProposal(session.generator.getCurrentProposalId()!);
    const claimed = proposal.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(claimed).toContain(SectionRef.headingKey(["Timeline"]));
    expect(claimed).not.toContain(SectionRef.headingKey(["Overview"]));
  });
});
