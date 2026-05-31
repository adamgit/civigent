import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createProposal } from "../../storage/proposal-repository.js";
import {
  evaluateAgentWritePolicy,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { ContentLayer, ProposalShadowContentLayer } from "../../storage/content-layer.js";
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

  function preserveHeadingMarkdown(level: number, heading: string, body: string): string {
    return `${"#".repeat(level)} ${heading}\n\n${body}`;
  }

  it("proposal with headed content does not produce doubled headings after commit", async () => {
    const headedContent = "## Overview\n\nUpdated overview content.\n";

    const { id, contentRoot } = await createProposal(
      writer,
      "Test double-heading fix",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
    );

    const pContentLayer = new ProposalShadowContentLayer(contentRoot, getContentRoot());
    await pContentLayer.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      "Overview",
      headedContent,
      { contentIsFullMarkdown: true },
    );

    const result = await evaluateAgentWritePolicy(id);
    await commitProposalToCanonical(id, AgentWritePolicy.buildCommittedProposalMetadata(result));

    const readLayer = new ContentLayer(getContentRoot());
    const assembled = await readLayer.readAssembledDocument(SAMPLE_DOC_PATH);

    const overviewMatches = assembled.match(/## Overview/g);
    expect(overviewMatches).toHaveLength(1);
    expect(assembled).toContain("Updated overview content.");
  });

  it("proposal with headed single-section content preserves a single timeline heading", async () => {
    const bodyOnlyContent = "Body-only content for timeline.\n";

    const { id, contentRoot } = await createProposal(
      writer,
      "Test body-only passthrough",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] }],
    );

    const pContentLayer = new ProposalShadowContentLayer(contentRoot, getContentRoot());
    await pContentLayer.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Timeline"]),
      "Timeline",
      preserveHeadingMarkdown(2, "Timeline", bodyOnlyContent.trimEnd()),
      { contentIsFullMarkdown: true },
    );

    const result = await evaluateAgentWritePolicy(id);
    await commitProposalToCanonical(id, AgentWritePolicy.buildCommittedProposalMetadata(result));

    const canonical = new ContentLayer(getContentRoot());
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);

    const timelineMatches = assembled.match(/## Timeline/g);
    expect(timelineMatches).toHaveLength(1);
    expect(assembled).toContain("Body-only content for timeline.");
  });
});
