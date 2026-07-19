/**
 * Claim-review 03 / Option E: the LIVE cross-section move is a CONTROL-PLANE
 * operation reachable ONLY through the narrow `requestDocSessionMove(...)` seam
 * (which the REST endpoint calls), NOT a CRDT binary frame. The seam looks up the
 * active DocSession, drives the reorder on the actor lane via `moveLiveSection`,
 * and returns the typed `{ ok, message }` the route maps to 200 / 409.
 *
 *  - no live session → refused with prose (the route maps to 409);
 *  - active session + valid sibling move → `{ ok:true }`, the live order reorders
 *    (the route maps to 200) — proving the seam routes through the actor lane;
 *  - a refusal (competing FSM lock) → `{ ok:false, message }`, order UNCHANGED.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { requestDocSessionMove } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";
import { joinLiveRecipient } from "../helpers/live-recipient.js";
import { decodeMessage, MSG_YJS_UPDATE } from "../../ws/crdt-ws-frames.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function liveHeadingOrder(session: DocSession): Promise<string[]> {
  const layout = await resolveLiveSectionLayout(session.docPath, session.generator.getCurrentProposalId());
  return layout.filter((e) => e.headingPath.length === 1).map((e) => e.heading);
}

describe("Option E: requestDocSessionMove REST control-plane seam", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("refuses with prose when there is no live session (route → 409)", async () => {
    const result = await requestDocSessionMove(SAMPLE_DOC_PATH, {
      sourceHeadingPath: ["Timeline"],
      targetHeadingPath: ["Overview"],
      position: "before",
    });
    expect(result.ok).toBe(false);
    expect(typeof result.message).toBe("string");
    expect(result.message!.length).toBeGreaterThan(0);
  });

  it("reorders the live layout for a valid sibling move (route → 200)", async () => {
    const session = await openSession();
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);

    const live = await joinLiveRecipient(session);
    live.clear();

    const result = await requestDocSessionMove(SAMPLE_DOC_PATH, {
      sourceHeadingPath: ["Timeline"],
      targetHeadingPath: ["Overview"],
      position: "before",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    expect(await liveHeadingOrder(session)).toEqual(["Timeline", "Overview"]);

    // Structural fan-out contract: a pure sibling reorder is TOPOLOGY-ONLY.
    // It arrives as ONE state-only live-section frame carrying the reordered
    // topology and NO yjs_update (fragments are untouched — reseeding them
    // would destroy mounted editors' Yjs structures), with no raw
    // MSG_YJS_UPDATE precursor.
    const frameTypes = live.raw
      .map((frame) => decodeMessage(frame)?.type)
      .filter((type): type is number => type !== undefined);
    expect(frameTypes).not.toContain(MSG_YJS_UPDATE);
    const moveFrames = live.updates();
    expect(moveFrames.length).toBe(1);
    expect(moveFrames[0].yjs_update).toBeUndefined();
    expect(moveFrames[0].state).toBeDefined();
    const topology = moveFrames[0].state!.topology;
    const topLevel = topology.filter((t) => t.heading_path.length === 1).map((t) => t.heading_path[0]);
    expect(topLevel).toEqual(["Timeline", "Overview"]);

    live.dispose();
  });

  it("refuses with prose and leaves order UNCHANGED when a competing proposal locks the target (route → 409)", async () => {
    const session = await openSession();

    const { id } = await createProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "Competing lock",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
    );
    expect((await transitionToInProgress(id)).acquired).toBe(true);

    const result = await requestDocSessionMove(SAMPLE_DOC_PATH, {
      sourceHeadingPath: ["Timeline"],
      targetHeadingPath: ["Overview"],
      position: "before",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/locked/i);
    // Section order unchanged on refusal.
    expect(await liveHeadingOrder(session)).toEqual(["Overview", "Timeline"]);
  });
});
