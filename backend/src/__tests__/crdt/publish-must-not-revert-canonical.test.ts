/**
 * REGRESSION (data-loss): a DocSession publish must NEVER revert canonical to a
 * stale structure, dropping sections that were committed to canonical AFTER the
 * DocSession's in-flight proposal was created.
 *
 * Reproduces the reported corruption: a document accumulates several committed
 * proposals (each adding sections) AFTER an `inprogress` proposal was opened. On
 * remount the DocSession adopts that stale `inprogress` proposal and resolves its
 * WHOLE-DOCUMENT layout from the proposal's (now stale) skeleton — which predates
 * the later canonical commits. A whole-document publish then materializes only
 * that stale section set and replaces canonical from it, deleting every section
 * the later commits added. The document "reverts in time".
 *
 * This test fails (canonical loses "Roadmap") until the seed/publish path stops
 * trusting a stale proposal skeleton as the authoritative whole-document layout.
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
  createTransientProposal,
} from "../../storage/proposal-repository.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot, getContentRoot } from "../../storage/data-root.js";
import { ProposalAdoptionId } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

describe("data-loss regression: DocSession publish must not revert canonical to a stale structure", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("does NOT delete a section that was committed to canonical after the in-flight proposal was opened", async () => {
    // 1. A live session opened an inprogress proposal and staged an Overview edit.
    const proposalAdoptionId = ProposalAdoptionId.create();
    const inflight = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId,
      docPath: SAMPLE_DOC_PATH,
      writer: WRITER,
    });
    await ProposalEditor.open(inflight.id, "inprogress").writeSection(
      SAMPLE_DOC_PATH,
      ["Overview"],
      "Overview",
      "Alice's in-flight overview edit.",
    );
    await updateCurrentProposalSections(inflight.id, [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);

    // 2. AFTER that, a separate proposal commits a brand-new section to canonical.
    const { id: externalId } = await createTransientProposal(
      { id: "user-bob", type: "human", displayName: "Bob" },
      "add roadmap section",
    );
    await mutateProposalContent(externalId, {
      kind: "write_section",
      docPath: SAMPLE_DOC_PATH,
      headingPath: ["Roadmap"],
      heading: "Roadmap",
      content: "ROADMAP COMMITTED AFTER THE INPROGRESS PROPOSAL WAS OPENED",
    });
    await commitProposalToCanonicalDetailed(externalId, {});

    // Canonical now genuinely contains Roadmap.
    const roadmapKey = SectionRef.headingKey(["Roadmap"]);
    const beforePublish = await new ContentLayer(getContentRoot()).readAllSections(SAMPLE_DOC_PATH);
    expect(beforePublish.has(roadmapKey)).toBe(true);

    // 3. Remount: a fresh acquire adopts the stale inprogress proposal.
    destroyAllSessions();
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-restart");
    expect(session.generator.getCurrentProposalId()).toBe(inflight.id);

    // 4. The DocSession publishes (whole-document materialize + commit).
    const result = await session.generator.finalizeAndPublish();
    expect(result.status).toBe("committed");

    // 5. Roadmap MUST still exist in canonical — the publish must not have
    //    reverted the document to its pre-Roadmap structure.
    const afterPublish = await new ContentLayer(getContentRoot()).readAllSections(SAMPLE_DOC_PATH);
    expect(afterPublish.has(roadmapKey)).toBe(true);
    expect(afterPublish.get(roadmapKey) as string).toContain(
      "ROADMAP COMMITTED AFTER THE INPROGRESS PROPOSAL WAS OPENED",
    );
  });
});
