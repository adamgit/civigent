/**
 * Document-target lock conflict shape (spec 12 §Data Shapes / §Locking).
 *
 * A document target conflicts with:
 *   - a document claim on the same doc_path;
 *   - any section claim under that document; and
 * a section target conflicts with a document claim covering its document.
 * Each conflict carries the structured payload (target + blocking proposal
 * id/status/writer + prose message).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  createTransientProposal,
  transitionToCommitting,
  createProposal,
  transitionToInProgress,
} from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { checkProposalLocks } from "../../domain/proposal-fsm-locks.js";
import { documentTargetRef } from "../../types/shared.js";

const AGENT = { id: "agent-doc", type: "agent" as const, displayName: "Agent" };
const HUMAN = { id: "human-sec", type: "human" as const, displayName: "Human" };

describe("document-target lock conflict shape (spec 12)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("a document-target holder blocks BOTH a same-document target and a section under it", async () => {
    // A committing proposal holding a DOCUMENT claim on the sample doc.
    const { id: docHolder } = await createTransientProposal(AGENT, "delete doc");
    await mutateProposalContent(docHolder, { kind: "delete_document", docPath: SAMPLE_DOC_PATH });
    await transitionToCommitting(docHolder);

    // A new proposal targeting the SAME document conflicts.
    const docVsDoc = await checkProposalLocks({
      proposalId: "new-doc-proposal",
      targets: [documentTargetRef(SAMPLE_DOC_PATH)],
    });
    expect(docVsDoc.acquired).toBe(false);
    expect(docVsDoc.conflicts).toHaveLength(1);
    expect(docVsDoc.conflicts[0].blockingProposalId).toBe(docHolder);
    expect(docVsDoc.conflicts[0].blockingProposalStatus).toBe("committing");
    expect(docVsDoc.conflicts[0].target).toEqual(documentTargetRef(SAMPLE_DOC_PATH));
    expect(typeof docVsDoc.conflicts[0].message).toBe("string");

    // A new proposal targeting a SECTION under that document also conflicts.
    const sectionUnderDoc = await checkProposalLocks({
      proposalId: "new-section-proposal",
      targets: [{ kind: "section", doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
    });
    expect(sectionUnderDoc.acquired).toBe(false);
    expect(sectionUnderDoc.conflicts).toHaveLength(1);
    expect(sectionUnderDoc.conflicts[0].blockingProposalId).toBe(docHolder);
  });

  it("a section-target holder blocks a document target covering its document", async () => {
    // A human inprogress proposal holding a SECTION claim.
    const { id: sectionHolder } = await createProposal(HUMAN, "edit overview", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);
    const acquired = await transitionToInProgress(sectionHolder);
    expect(acquired.acquired).toBe(true);

    // A new DOCUMENT target over the same document conflicts with the section holder.
    const docVsSection = await checkProposalLocks({
      proposalId: "new-doc-proposal",
      targets: [documentTargetRef(SAMPLE_DOC_PATH)],
    });
    expect(docVsSection.acquired).toBe(false);
    expect(docVsSection.conflicts).toHaveLength(1);
    expect(docVsSection.conflicts[0].blockingProposalId).toBe(sectionHolder);
    expect(docVsSection.conflicts[0].blockingProposalStatus).toBe("inprogress");
    expect(docVsSection.conflicts[0].target).toEqual(documentTargetRef(SAMPLE_DOC_PATH));
  });
});
