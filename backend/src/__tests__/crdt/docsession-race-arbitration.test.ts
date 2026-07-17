/**
 * MW-6: DocSession race arbitration (spec 01 §CRDTProposalGenerator
 * "Race arbitration").
 *
 * Exercises the REAL actor-lane edit body (`processArbitratedClientUpdate`)
 * against a real DocSession Y.Doc and the real proposal FSM lock subsystem:
 *
 *  (a) competing-proposal-wins: a SEPARATE proposal holds an exclusive
 *      (`inprogress`) lock on section X → a live edit to X is NOT materialized
 *      into the DocSession proposal AND X is in the live `blocked_section_ids`
 *      pushed on the ordered CRDT channel (the redesign moved editability
 *      authority off the app-WS `section:blocked` event onto that state frame).
 *  (b) live-edit-wins: no competing claim → the live edit IS materialized and X
 *      is not blocked (current behaviour preserved).
 *
 * The tests fail if the arbitration is reverted: without it, the blocked edit
 * would be materialized (X unblocked, a current proposal would exist).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  processArbitratedClientUpdate,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { joinLiveRecipient } from "../helpers/live-recipient.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/**
 * Build a client Yjs update that rewrites the Overview fragment to `content`,
 * relative to the session's current Y.Doc state (a real diff update, exactly the
 * shape a browser editor would send).
 */
function buildClientUpdateForOverview(session: DocSession, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(OVERVIEW_KEY, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

/** Create a competing human `inprogress` proposal holding an exclusive lock on a section. */
async function lockSectionWithCompetingProposal(headingPath: string[]): Promise<string> {
  const { id } = await createProposal(
    { id: "user-bob", type: "human", displayName: "Bob" },
    "Competing lock",
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: headingPath }],
  );
  const result = await transitionToInProgress(id);
  expect(result.acquired).toBe(true);
  return id;
}

describe("MW-6: DocSession race arbitration", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("(a) competing proposal wins: live edit to X is NOT materialized + X is in live blocked_section_ids", async () => {
    const session = await openSession();
    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);
    // A competing proposal exclusively locks Overview.
    await lockSectionWithCompetingProposal(["Overview"]);

    const edited = buildFragmentContent("alice attempts to edit overview" as SectionBody, 2, "Overview");
    const update = buildClientUpdateForOverview(session, edited);

    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // The edit was reverted — the DocSession never materialized a proposal.
    expect(session.generator.hasCurrentProposal()).toBe(false);
    // The live fragment is back to the canonical Overview content (read-only).
    const after = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(after).not.toContain("alice attempts to edit overview");
    expect(after).toContain("The overview covers our strategic goals.");
    // The blocked editable set was refreshed on the ordered CRDT channel as a
    // state-only update frame; Overview's fragment is in it.
    const stateFrames = live.updates().filter((u) => u.state !== undefined);
    expect(stateFrames.length).toBeGreaterThanOrEqual(1);
    expect(live.latestState().blocked_section_ids).toContain(OVERVIEW_KEY);
    // The section is still in live topology (blocked ≠ gone).
    expect(live.latestState().topology.map((t) => t.fragment_key)).toContain(OVERVIEW_KEY);
  });

  it("(b) live edit wins: no competing claim → the edit IS materialized and X is not blocked", async () => {
    const session = await openSession();
    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);

    const edited = buildFragmentContent("alice freely edits overview" as SectionBody, 2, "Overview");
    const update = buildClientUpdateForOverview(session, edited);

    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // No competing lock → the edit materialized into the DocSession proposal.
    expect(session.generator.hasCurrentProposal()).toBe(true);
    const after = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(after).toContain("alice freely edits overview");
    // Overview is never in the blocked set (the session's own proposal is excluded).
    expect(live.latestState().blocked_section_ids).not.toContain(OVERVIEW_KEY);
  });

  it("(b2) the live session's OWN proposal does not block its own edits", async () => {
    const session = await openSession();
    const live = await joinLiveRecipient(session);
    disposers.push(live.dispose);
    // First edit materializes the DocSession's own inprogress proposal (which now
    // holds a claim on Overview). A second edit to the SAME section must still win.
    const first = buildFragmentContent("first edit" as SectionBody, 2, "Overview");
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, buildClientUpdateForOverview(session, first)));
    expect(session.generator.hasCurrentProposal()).toBe(true);

    const second = buildFragmentContent("second edit by same author" as SectionBody, 2, "Overview");
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, buildClientUpdateForOverview(session, second)));

    const after = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(after).toContain("second edit by same author");
    // The section is never blocked against its own author across both edits.
    expect(live.latestState().blocked_section_ids).not.toContain(OVERVIEW_KEY);
  });
});
