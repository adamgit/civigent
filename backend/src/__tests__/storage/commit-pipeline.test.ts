import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createProposal, readProposal } from "../../storage/proposal-repository.js";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";

describe("commit-pipeline", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const writer = { id: "agent-test", type: "agent" as const, displayName: "Test Agent" };

  it("evaluateProposalHumanInvolvement computes per-section involvement scores", async () => {
    const proposal = await createProposal(
      writer,
      "Test evaluation",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Updated overview.\n" }],
    );

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

    expect(evaluation).toHaveProperty("all_sections_accepted");
    expect(evaluation).toHaveProperty("aggregate_impact");
    expect(evaluation).toHaveProperty("aggregate_threshold");
    expect(evaluation).toHaveProperty("blocked_sections");
    expect(evaluation).toHaveProperty("passed_sections");
    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0]).toHaveProperty("humanInvolvement_score");
  });

  it("evaluateProposalHumanInvolvement returns all_sections_accepted for uncontested sections", async () => {
    const proposal = await createProposal(
      writer,
      "Uncontested evaluation",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "Timeline update.\n" }],
    );

    const { evaluation } = await evaluateProposalHumanInvolvement(proposal);
    // No active sessions, no recent human edits → should pass
    expect(evaluation.all_sections_accepted).toBe(true);
  });

  it("evaluateProposalHumanInvolvement sections include doc_path and heading_path", async () => {
    const proposal = await createProposal(
      writer,
      "Section fields test",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Test.\n" }],
    );

    const { sections } = await evaluateProposalHumanInvolvement(proposal);
    expect(sections[0].doc_path).toBe(SAMPLE_DOC_PATH);
    expect(sections[0].heading_path).toEqual(["Overview"]);
    expect(typeof sections[0].humanInvolvement_score).toBe("number");
  });

  it("commitProposalToCanonical writes sections and returns commit SHA", async () => {
    const proposal = await createProposal(
      writer,
      "Test commit",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Committed content.\n" }],
    );

    const { sections } = await evaluateProposalHumanInvolvement(proposal);
    const scores: Record<string, number> = {};
    for (const s of sections) {
      const key = `${s.doc_path}::${s.heading_path.join(">>")}`;
      scores[key] = s.humanInvolvement_score;
    }

    const committedHead = await commitProposalToCanonical(proposal, scores);
    expect(typeof committedHead).toBe("string");
    expect(committedHead.length).toBe(40); // SHA hex
  });

  it("commitProposalToCanonical transitions proposal to committed state", async () => {
    const proposal = await createProposal(
      writer,
      "State transition test",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "Committed timeline.\n" }],
    );

    const scores: Record<string, number> = {};
    scores[`${SAMPLE_DOC_PATH}::Timeline`] = 0;

    await commitProposalToCanonical(proposal, scores);

    // Read the proposal back to verify it's committed
    const read = await readProposal(proposal.id);
    expect(read.status).toBe("committed");
    expect(read.committed_head).toBeDefined();
  });
});
