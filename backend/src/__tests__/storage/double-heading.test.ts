import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createProposal } from "../../storage/proposal-repository.js";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";
import { SectionRef } from "../../domain/section-ref.js";

describe("double-heading bug fix", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const writer = { id: "agent-test", type: "agent" as const, displayName: "Test Agent" };

  it("proposal with headed content does not produce doubled headings after commit", async () => {
    const headedContent = "## Overview\n\nUpdated overview content.\n";

    const { id, contentRoot } = await createProposal(
      writer,
      "Test double-heading fix",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
    );

    const pContentLayer = new OverlayContentLayer(contentRoot, getContentRoot());
    await pContentLayer.writeSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      headedContent,
    );

    const { sections } = await evaluateProposalHumanInvolvement(id);
    const scores: Record<string, number> = {};
    for (const s of sections) {
      const key = `${s.doc_path}::${s.heading_path.join(">>")}`;
      scores[key] = s.humanInvolvement_score;
    }
    await commitProposalToCanonical(id, scores);

    const readLayer = new ContentLayer(getContentRoot());
    const assembled = await readLayer.readAssembledDocument(SAMPLE_DOC_PATH);

    const overviewMatches = assembled.match(/## Overview/g);
    expect(overviewMatches).toHaveLength(1);
    expect(assembled).toContain("Updated overview content.");
  });

  it("proposal with body-only content passes through unchanged", async () => {
    const bodyOnlyContent = "Body-only content for timeline.\n";

    const { id, contentRoot } = await createProposal(
      writer,
      "Test body-only passthrough",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] }],
    );

    const pContentLayer = new OverlayContentLayer(contentRoot, getContentRoot());
    await pContentLayer.writeSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Timeline"]),
      bodyOnlyContent,
    );

    const { sections } = await evaluateProposalHumanInvolvement(id);
    const scores: Record<string, number> = {};
    for (const s of sections) {
      const key = `${s.doc_path}::${s.heading_path.join(">>")}`;
      scores[key] = s.humanInvolvement_score;
    }
    await commitProposalToCanonical(id, scores);

    const canonical = new ContentLayer(getContentRoot());
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);

    const timelineMatches = assembled.match(/## Timeline/g);
    expect(timelineMatches).toHaveLength(1);
    expect(assembled).toContain("Body-only content for timeline.");
  });
});
