/**
 * MW-4 — in-acquire Y.Doc reseed from canonical + an EXISTING `inprogress`
 * proposal (spec 05 §Y.Doc Construction / latent-proposal model).
 *
 * On remount/restart the live Y.Doc must be reconstructed NOT just from canonical
 * but from the DocSession's existing `inprogress` proposal content tree when one
 * exists — that proposal is the durable in-flight state across a disconnect. This
 * test creates an `inprogress` proposal whose in-flight content DIFFERS from
 * canonical, simulates a restart (`destroyAllSessions()`), re-acquires fresh, and
 * asserts the live Y.Doc fragments carry the in-flight proposal content (not the
 * stale canonical body).
 *
 * It fails if the acquire reseed reads canonical only (ignoring the inprogress
 * proposal): the negative-control test (a doc with NO inprogress proposal) proves
 * the assertion is specific to the inprogress reseed, not to canonical content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import {
  getOrCreateInProgressProposalForAdoptionId,
  updateCurrentProposalSections,
  findInProgressProposalForDoc,
  listInProgressProposalsForDoc,
} from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import { ProposalAdoptionId } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const IN_FLIGHT_BODY = "IN-FLIGHT BODY ONLY IN THE INPROGRESS PROPOSAL";
const CANONICAL_BODY = "The overview covers our strategic goals.";

describe("MW-4: acquire reseeds the live Y.Doc from an existing inprogress proposal", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("a fresh acquire after a restart reflects the inprogress proposal's in-flight content", async () => {
    // Stage an inprogress proposal whose Overview body diverges from canonical,
    // simulating in-flight live work that was materialized but not yet published.
    const proposalAdoptionId = ProposalAdoptionId.create();
    const created = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: SAMPLE_DOC_PATH,
      writer: WRITER,
    });
    const editor = ProposalEditor.open(created.id, "inprogress");
    await editor.writeSection(SAMPLE_DOC_PATH, ["Overview"], "Overview", IN_FLIGHT_BODY);
    await updateCurrentProposalSections(created.id, [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);

    // Sanity: the inprogress proposal is discoverable for this doc.
    expect((await findInProgressProposalForDoc(SAMPLE_DOC_PATH))?.id).toBe(created.id);

    // Simulate a remount/restart: discard all in-memory sessions, then acquire fresh.
    destroyAllSessions();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-fresh");

    // The reseeded live fragment must reflect the in-flight proposal content,
    // NOT the stale canonical body.
    const overview = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overview).toContain(IN_FLIGHT_BODY);
    expect(overview).not.toContain(CANONICAL_BODY);
  });

  it("negative control: with NO inprogress proposal, acquire reseeds from canonical", async () => {
    destroyAllSessions();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-canon");

    const overview = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(overview).toContain(CANONICAL_BODY);
    expect(overview).not.toContain(IN_FLIGHT_BODY);
  });
});

/**
 * C1 — a reconstructed DocSession must ADOPT the existing `inprogress` proposal,
 * not orphan it and fork a second one on the first edit. This is the
 * PROPOSAL-IDENTITY half of recovery (the test above covers CONTENT seeding).
 */
describe("C1: acquire adopts the existing inprogress proposal identity", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("a restart re-acquire adopts the existing proposal id and does NOT fork a second one on first edit", async () => {
    // Stage an inprogress proposal for the doc (with in-flight content), as a
    // prior live session would have left behind.
    const proposalAdoptionId = ProposalAdoptionId.create();
    const created = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: SAMPLE_DOC_PATH,
      writer: WRITER,
    });
    const editor = ProposalEditor.open(created.id, "inprogress");
    await editor.writeSection(SAMPLE_DOC_PATH, ["Overview"], "Overview", IN_FLIGHT_BODY);
    await updateCurrentProposalSections(created.id, [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);

    // Exactly one inprogress proposal targets the doc to begin with.
    expect((await listInProgressProposalsForDoc(SAMPLE_DOC_PATH)).map((p) => p.id)).toEqual([
      created.id,
    ]);

    // Simulate a remount/restart, then re-acquire fresh.
    destroyAllSessions();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-restart");

    // Adoption is explicit at construction: the generator already points at the
    // existing proposal BEFORE any edit (no fork-on-first-edit window).
    expect(session.generator.getCurrentProposalId()).toBe(created.id);

    // Make ONE edit and materialize it. It must land in the adopted proposal.
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      buildFragmentContent("Edited after restart.", 2, "Overview"),
    );
    const materializedInto = await session.generator.materializeEdit();
    expect(materializedInto).toBe(created.id);

    // No second inprogress proposal was forked for this doc.
    const after = await listInProgressProposalsForDoc(SAMPLE_DOC_PATH);
    expect(after.map((p) => p.id)).toEqual([created.id]);
    expect(session.generator.getCurrentProposalId()).toBe(created.id);
  });
});
