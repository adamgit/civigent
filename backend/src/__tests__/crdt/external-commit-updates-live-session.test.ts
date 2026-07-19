/**
 * External proposal commits update the active Y.Doc IN PLACE — no full
 * page/session reset (spec 01 "one primitive, both directions"; spec 05
 * §Proposal Publication: agent/human deltas still apply back into any active live
 * Y.Doc).
 *
 * The wiring test (`live-session-wiring.test.ts` MW-3) proves the committed
 * content reaches the live fragment. THIS test pins the stronger "no reset"
 * contract that the item demands and that a generic "commit event emitted" check
 * would miss:
 *
 *  - the SAME DocSession instance / Y.Doc survives the external commit (same
 *    `proposalAdoptionId`, same `ydoc` object reference, still `active`);
 *  - a LOCAL uncommitted edit on a DIFFERENT section is PRESERVED across the
 *    external commit — a full reseed/reset would have wiped it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  lookupDocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { applyCommittedCanonicalToLiveSession } from "../../ws/crdt-ws-coordinator.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createTransientProposal } from "../../storage/proposal-repository.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession() {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: { enqueue: <T>(c: () => T | Promise<T>) => Promise<T> }) {
  await session.enqueue(() => undefined);
}

describe("external commit updates the active live Y.Doc without a session reset", () => {
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

  it("applies the external commit in place and preserves a local uncommitted edit on another section", async () => {
    const session = await openSession();
    const proposalAdoptionIdBefore = session.proposalAdoptionId;
    const ydocBefore = session.ydoc;

    // Alice has a LOCAL, uncommitted edit on Timeline (in this DocSession only).
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      buildFragmentContent("alice's local unpublished timeline" as SectionBody, 2, "Timeline"),
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    // A SEPARATE writer commits a change to Overview via a distinct proposal.
    const { id: externalProposalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "edit overview externally",
    );
    await mutateProposalContent(externalProposalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Overview"],
      heading: "Overview",
      content: "EXTERNALLY COMMITTED OVERVIEW",
    });
    const absorb = await commitProposalToCanonicalDetailed(externalProposalId, {});
    const changedHeadingPaths = absorb.changedSections.map((s) => [...s.headingPath]);

    // Apply the external committed canonical change into the live session.
    await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, changedHeadingPaths, externalProposalId);
    await drainLane(session);

    // The SAME session/Y.Doc is still live (no reset/replacement).
    const sameSession = lookupDocSession(SAMPLE_DOC_PATH);
    expect(sameSession).toBe(session);
    expect(sameSession?.proposalAdoptionId).toBe(proposalAdoptionIdBefore);
    expect(sameSession?.ydoc).toBe(ydocBefore);
    expect(sameSession?.state).toBe("active");

    // Overview reflects the external commit...
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).toContain(
      "EXTERNALLY COMMITTED OVERVIEW",
    );
    // ...while Alice's local uncommitted Timeline edit is PRESERVED (not reset).
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY) as string).toContain(
      "alice's local unpublished timeline",
    );
  });

  it("unregisters a live fragment when an external commit deletes an inherited section", async () => {
    const session = await openSession();

    // Alice claims only Overview in this DocSession. Timeline remains an
    // inherited canonical section, so an external delete is allowed to remove it.
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("alice's local unpublished overview" as SectionBody, 2, "Overview"),
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });

    const { id: externalProposalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "delete timeline externally",
    );
    await mutateProposalContent(externalProposalId, {
      kind: "delete_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Timeline"],
    });
    const absorb = await commitProposalToCanonicalDetailed(externalProposalId, {});
    const changedHeadingPaths = absorb.changedSections.map((s) => [...s.headingPath]);

    await applyCommittedCanonicalToLiveSession(SAMPLE_DOC_PATH, changedHeadingPaths, externalProposalId);
    await drainLane(session);

    const effectiveLayout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    expect(effectiveLayout.map((entry) => entry.headingPath.join(">>"))).not.toContain("Timeline");
    expect(session.liveFragments.getFragmentKeys()).not.toContain(TIMELINE_KEY);
  });
});
