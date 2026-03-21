/**
 * Integration test: import → commit → read round-trip.
 * Verifies that the full import-to-canonical path through the proposal system
 * produces correct content with all sections intact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { evaluateProposalHumanInvolvement, commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { readAssembledDocument } from "../../storage/document-reader.js";
import { SectionRef } from "../../domain/section-ref.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getContentRoot } from "../../storage/data-root.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

describe("import → commit → read round-trip", () => {
  let ctx: TempDataRootContext;

  const writer = { id: "human-importer", type: "human" as const, displayName: "Importer" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    // Need at least one committed doc for the git repo to be non-empty
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("multi-section markdown import produces all sections in canonical", async () => {
    const markdown = [
      "# Test Import Doc",
      "",
      "This is the preamble.",
      "",
      "## Introduction",
      "",
      "This is the introduction section.",
      "",
      "## Methods",
      "",
      "These are the methods.",
      "",
    ].join("\n");

    const docPath = "import-test.md";

    // Import
    const { id } = await importFilesToProposal(
      [{ docPath, content: markdown }],
      writer,
      "Test import",
    );

    // Read fresh proposal and commit
    const { sections } = await evaluateProposalHumanInvolvement(id);
    const scores: Record<string, number> = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    await commitProposalToCanonical(id, scores);

    // Read from canonical
    const assembled = await readAssembledDocument(docPath);

    // All sections should be present
    expect(assembled).toContain("This is the preamble.");
    expect(assembled).toContain("## Introduction");
    expect(assembled).toContain("This is the introduction section.");
    expect(assembled).toContain("## Methods");
    expect(assembled).toContain("These are the methods.");
  });

  it("imported doc with nested headings has all body files in canonical", async () => {
    const markdown = [
      "Root content.",
      "",
      "## Overview",
      "",
      "Overview body.",
      "",
      "### Details",
      "",
      "Details body.",
      "",
    ].join("\n");

    const docPath = "nested-import.md";

    const { id } = await importFilesToProposal(
      [{ docPath, content: markdown }],
      writer,
      "Test nested import",
    );

    const { sections } = await evaluateProposalHumanInvolvement(id);
    const scores: Record<string, number> = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    await commitProposalToCanonical(id, scores);

    // Verify skeleton + body files exist on disk
    const contentRoot = getContentRoot();
    const skeletonPath = join(contentRoot, docPath);
    const sectionsDir = `${skeletonPath}.sections`;

    await expect(stat(skeletonPath)).resolves.toBeDefined();
    await expect(stat(sectionsDir)).resolves.toBeDefined();

    // Read via /sections-style API to verify all sections have content
    const layer = new ContentLayer(contentRoot);
    const allContent = await layer.readAllSectionsOverlaid(docPath);

    // Should have at least root + Overview + Details
    expect(allContent.size).toBeGreaterThanOrEqual(3);

    // No section should be empty
    for (const [key, content] of allContent) {
      expect(content.trim().length, `Section "${key}" should not be empty`).toBeGreaterThan(0);
    }
  });

  it("imported doc is readable via readAssembledDocument with full content", async () => {
    const markdown = [
      "Preamble text.",
      "",
      "## Section A",
      "",
      "Content A.",
      "",
      "## Section B",
      "",
      "Content B.",
      "",
    ].join("\n");

    const docPath = "readable-import.md";

    const { id } = await importFilesToProposal(
      [{ docPath, content: markdown }],
      writer,
      "Test readable import",
    );

    const { sections } = await evaluateProposalHumanInvolvement(id);
    const scores: Record<string, number> = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    await commitProposalToCanonical(id, scores);

    // Read assembled — should not throw and should contain all content
    const assembled = await readAssembledDocument(docPath);
    expect(assembled).toContain("Preamble text.");
    expect(assembled).toContain("Content A.");
    expect(assembled).toContain("Content B.");
  });
});
