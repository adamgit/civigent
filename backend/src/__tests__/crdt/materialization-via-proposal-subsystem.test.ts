/**
 * CRDT materialization uses the Proposal subsystem (todolist item 34).
 *
 * A live section snapshot edit materializes into the DocSession's current
 * `inprogress` proposal, and the result is fully observable through the proposal
 * subsystem read API (`ProposalReader`) — the generator mutates the proposal
 * through `ProposalEditor`, never via a root-pair / overlay content-layer
 * abstraction. (The "no root-pair import" property is separately enforced by
 * `storage/proposal-shadow-layer-boundary.test.ts`.)
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
import { ProposalReader } from "../../storage/proposal-reader.js";

const WRITER = { id: "user-i34", type: "human" as const, displayName: "I34" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-i34");
}

function buildOverviewEdit(session: DocSession, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(OVERVIEW_KEY, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

describe("CRDT materialization via the Proposal subsystem (item 34)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => {});
  });

  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("a live snapshot edit mutates the current inprogress proposal, readable via ProposalReader", async () => {
    const session = await openSession();

    const edited = buildFragmentContent("i34 overview snapshot edit" as SectionBody, 2, "Overview");
    const update = buildOverviewEdit(session, edited);
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // Materialization created/updated the DocSession's current inprogress proposal.
    const proposalId = session.generator.getCurrentProposalId();
    expect(proposalId).toBeTruthy();

    // The proposal content tree is observable through the proposal subsystem read
    // API — the edit landed in the inprogress proposal, not canonical.
    const reader = ProposalReader.open(proposalId!, "inprogress");
    expect(await reader.getDocumentState(SAMPLE_DOC_PATH)).toBe("live");
    const overviewBody = await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(overviewBody).toContain("i34 overview snapshot edit");

    // The proposal manifest claims the Overview section it materialized.
    const headingKeys = (await reader.listHeadingPaths(SAMPLE_DOC_PATH)).map((p) => p.join(" > "));
    expect(headingKeys).toContain("Overview");
  });
});
