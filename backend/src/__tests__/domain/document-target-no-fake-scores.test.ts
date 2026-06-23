/**
 * Document targets do not fabricate section-score details or misleading commit
 * metadata (spec 12 §Data Shapes; Claim 10).
 *
 * The Agent Write Policy scores SECTION targets only. A document-level operation
 * (e.g. delete_document) carries a DOCUMENT target and no section targets, so its
 * policy evaluation must produce no per-section score entries, and its committed
 * metadata must carry no fabricated section scores.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createTransientProposal, readProposal } from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";

const AGENT = { id: "agent-doc", type: "agent" as const, displayName: "Agent" };

describe("document target — no fake section scores (spec 12)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("a document-target proposal produces no per-section score entries or fabricated commit metadata", async () => {
    const { id } = await createTransientProposal(AGENT, "delete the document");
    await mutateProposalContent(id, { kind: "delete_document", docPath: SAMPLE_DOC_PATH });

    // The proposal carries a DOCUMENT target.
    const proposal = await readProposal(id);
    expect(proposal.targets.some((t) => t.kind === "document" && t.doc_path === SAMPLE_DOC_PATH)).toBe(true);

    const result = await AgentWritePolicy.evaluateProposal(id);

    // The document target is NEVER scored as a section — every scored entry is a
    // real section, and the scored set is exactly the manifest's real sections
    // (no fabricated section-score for the document target).
    expect(result.targets.every((t) => t.target.kind === "section")).toBe(true);
    const scoredKeys = result.targets
      .map((t) => `${t.target.doc_path}::${(t.target as { heading_path: string[] }).heading_path.join(">")}`)
      .sort();
    const manifestKeys = proposal.sections
      .map((s) => `${s.doc_path}::${s.heading_path.join(">")}`)
      .sort();
    expect(scoredKeys).toEqual(manifestKeys);

    // Committed metadata is keyed only by real scored sections — nothing
    // fabricated for the document target itself.
    const metadata = AgentWritePolicy.buildCommittedProposalMetadata(result);
    expect(Object.keys(metadata).length).toBe(result.targets.length);
    // The bare document path (no section) never appears as a metadata key.
    expect(Object.keys(metadata)).not.toContain(SAMPLE_DOC_PATH);
  });
});
