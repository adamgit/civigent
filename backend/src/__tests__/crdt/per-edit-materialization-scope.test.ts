/**
 * C4 — per-edit materialization is SCOPED to the touched section(s); the live
 * `inprogress` proposal's lock claim grows section-by-section, NOT whole-doc.
 *
 * Before C4 every live keystroke whole-doc materialized and replaced the proposal
 * manifest with the entire snapshot, so the FSM lock index (which reads
 * `proposal.sections`) locked EVERY section against agents on the first edit — an
 * inversion of the section-by-section contention model. This test edits ONE
 * section in a multi-section doc and asserts:
 *  (1) the proposal's `sections` claim contains only that section (+ any required
 *      ancestors), not the whole document; and
 *  (2) an agent proposal targeting an UNTOUCHED section is NOT blocked.
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
import { readProposal } from "../../storage/proposal-repository.js";
import { checkProposalLocks } from "../../domain/proposal-fsm-locks.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

function buildClientUpdateForOverview(session: DocSession, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(OVERVIEW_KEY, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

describe("C4: per-edit materialization is scoped to the touched section", () => {
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

  it("editing one section claims only that section — an agent write to an untouched section is NOT blocked", async () => {
    const session = await openSession();

    // Alice edits ONLY the Overview section.
    const edited = buildFragmentContent("alice edits only overview" as SectionBody, 2, "Overview");
    const update = buildClientUpdateForOverview(session, edited);
    await session.enqueue(() => processArbitratedClientUpdate(session, WRITER.id, update));

    // The live inprogress proposal claims ONLY Overview (not the whole document).
    const proposalId = session.generator.getCurrentProposalId()!;
    expect(proposalId).toBeTruthy();
    const proposal = await readProposal(proposalId);
    const claimedKeys = proposal.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(claimedKeys).toContain(SectionRef.headingKey(["Overview"]));
    // The sample doc has more than one section; none of the OTHERS are claimed.
    expect(claimedKeys).not.toContain(SectionRef.headingKey(["Timeline"]));
    expect(proposal.sections).toHaveLength(1);

    // The CONTENTION-MODEL regression: an agent write to an UNTOUCHED section
    // (Timeline) is NOT blocked by the live proposal's claim on Overview.
    const timelineLock = await checkProposalLocks({
      targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] }],
    });
    expect(timelineLock.acquired).toBe(true);

    // ...while a write to the touched section (Overview) IS contended.
    const overviewLock = await checkProposalLocks({
      targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
    });
    expect(overviewLock.acquired).toBe(false);
  });
});
