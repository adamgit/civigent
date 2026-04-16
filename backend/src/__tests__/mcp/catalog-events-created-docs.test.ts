/**
 * Unit test for summarizeProposalCatalogMutations in backend/src/mcp/catalog-events.ts.
 *
 * Diagnoses "MCP-created documents don't appear in sidebar tree" by isolating the
 * summarizer from the full MCP pipeline.
 *
 * Scenario:
 *   1. Create a draft proposal whose sections target a brand-new doc path that
 *      does not exist in canonical content.
 *   2. Write the section content to the proposal's draft overlay root via
 *      OverlayContentLayer.upsertSection — the same call the real
 *      create_proposal MCP handler makes.
 *   3. Call summarizeProposalCatalogMutations(proposal) directly.
 *   4. Assert createdDocPaths contains the new doc path and catalogChanged is
 *      true.
 *
 * Failure modes this guards against:
 *   - Draft overlay .md skeleton not written at resolveSkeletonPath(docPath,
 *     overlayRoot) after upsertSection (summarizer's listOverlayDocPaths walk
 *     sees nothing, createdDocPaths comes back empty, catalog:changed fires
 *     with added_doc_paths: []).
 *   - walkOverlayTree skipping the skeleton file (e.g. suffix filter bug,
 *     directory filter dropping too much).
 *   - proposal.sections.doc_path fed in but never reconciled against overlay
 *     state — causing reliance on overlay scan alone to silently omit the doc
 *     when the overlay write failed upstream.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import {
  createProposal,
  readProposal,
} from "../../storage/proposal-repository.js";
import { summarizeProposalCatalogMutations } from "../../mcp/catalog-events.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

describe("summarizeProposalCatalogMutations — new doc detection", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("detects a brand-new doc added via upsertSection against the draft overlay", async () => {
    const newDocPath = "/ops/brand-new-agent-doc.md";

    const { id, contentRoot } = await createProposal(
      { id: "agent-test", type: "agent", displayName: "Test Agent" },
      "Create a brand-new document",
      [{ doc_path: newDocPath, heading_path: ["Summary"] }],
    );

    const overlay = new OverlayContentLayer(contentRoot, ctx.contentDir);
    const ref = new SectionRef(newDocPath, ["Summary"]);
    await overlay.upsertSection(ref, "Summary", "Agent-authored body.");

    const proposal = await readProposal(id);
    const summary = await summarizeProposalCatalogMutations(proposal);

    expect(summary.catalogChanged).toBe(true);
    expect(summary.createdDocPaths).toContain(newDocPath);
    expect(summary.deletedDocPaths).toEqual([]);
    expect(summary.renamed).toBeNull();
  });

  it("detects a new doc even when the proposal's sections array omits doc_path, relying solely on the overlay walk", async () => {
    const newDocPath = "/ops/overlay-only-detection.md";

    const { id, contentRoot } = await createProposal(
      { id: "agent-test", type: "agent", displayName: "Test Agent" },
      "Create a doc visible only via overlay walk",
      [],
    );

    const overlay = new OverlayContentLayer(contentRoot, ctx.contentDir);
    const ref = new SectionRef(newDocPath, ["Intro"]);
    await overlay.upsertSection(ref, "Intro", "Body.");

    const proposal = await readProposal(id);
    const summary = await summarizeProposalCatalogMutations(proposal);

    expect(summary.catalogChanged).toBe(true);
    expect(summary.createdDocPaths).toContain(newDocPath);
  });

  it("reports no catalog change when the draft overlay stays empty", async () => {
    const { id } = await createProposal(
      { id: "agent-test", type: "agent", displayName: "Test Agent" },
      "Proposal with no overlay writes yet",
      [{ doc_path: "/ops/declared-but-not-written.md", heading_path: ["Intro"] }],
    );

    const proposal = await readProposal(id);
    const summary = await summarizeProposalCatalogMutations(proposal);

    expect(summary.catalogChanged).toBe(false);
    expect(summary.createdDocPaths).toEqual([]);
    expect(summary.deletedDocPaths).toEqual([]);
  });
});
