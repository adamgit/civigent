/**
 * MW-1 (rule 2) — last-editor-disconnect autonomous publish.
 *
 * When the LAST editor socket for a DocSession disconnects, the coordinator's
 * close handler publishes the DocSession's `inprogress` proposal into canonical
 * BEFORE the live Y.Doc is discarded (spec 10 §Default publish-trigger policy
 * rule 2), so live work is not stranded as an unpublished proposal.
 *
 * The decision + publish wiring is `publishOnLastEditorDisconnect`, called by the
 * production close handler with the post-disconnect editor count. These tests
 * drive that exact function (the same one the close handler calls) so they fail
 * if the last-editor-publish wiring is removed:
 *
 *  - last editor leaves (0 remaining) + a current `inprogress` proposal exists →
 *    the proposal is committed to canonical and the current-proposal reference is
 *    cleared (no forced/explicit publish call).
 *  - an editor still remains (>0) → NO publish (proposal retained).
 *  - no current proposal → NO publish (a zero-edit session has nothing to commit).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import { publishOnLastEditorDisconnect } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { findInProgressProposalForDoc, readProposal } from "../../storage/proposal-repository.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Flush the actor lane so any enqueued publish command settles. */
async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

describe("MW-1: last-editor-disconnect autonomous publish", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("publishes the inprogress proposal to canonical when the last editor disconnects", async () => {
    const session = await openSession();

    const edited: FragmentContent = buildFragmentContent(
      "published on last-editor disconnect" as SectionBody,
      2,
      "Overview",
    );
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, edited);
    const proposalId = await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);
    // The session currently owns an inprogress proposal for this document.
    expect((await findInProgressProposalForDoc(SAMPLE_DOC_PATH))?.id).toBe(proposalId);

    // Simulate the close handler's last-editor case: 0 editors remaining.
    const decision = await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);

    // The last-editor-left rule fired and the proposal was committed: the
    // current-proposal reference is cleared and the proposal record is committed.
    expect(decision.shouldPublish).toBe(true);
    expect(decision.rule).toBe("last-editor-left");
    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(await findInProgressProposalForDoc(SAMPLE_DOC_PATH)).toBeNull();
    const record = await readProposal(proposalId);
    expect(record.status).toBe("committed");
  });

  it("does NOT publish while another editor remains attached", async () => {
    const session = await openSession();
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("still editing" as SectionBody, 2, "Overview"),
    );
    await session.generator.materializeEdit();
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // One editor still attached → not the last-editor case.
    const decision = await publishOnLastEditorDisconnect(session, 1);
    await drainLane(session);

    expect(decision.shouldPublish).toBe(false);
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  it("does NOT publish a zero-edit session (no current proposal)", async () => {
    const session = await openSession();
    expect(session.generator.hasCurrentProposal()).toBe(false);

    const decision = await publishOnLastEditorDisconnect(session, 0);
    await drainLane(session);

    expect(decision.shouldPublish).toBe(false);
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });
});
