/**
 * Repro test: deeply nested import → read via /sections API path
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument } from "../helpers/sample-content.js";
import { importFilesToProposal } from "../../storage/import-service.js";
import { commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getContentRoot, getSessionDocsContentRoot } from "../../storage/data-root.js";
import { readAssembledDocument } from "../../storage/document-reader.js";
import { SectionRef } from "../../domain/section-ref.js";
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("deeply nested import repro", () => {
  let ctx: TempDataRootContext;
  const writer = { id: "human-importer", type: "human" as const, displayName: "Importer" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    await mkdir(getSessionDocsContentRoot(), { recursive: true });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("deeply nested doc (# > ## > ###) survives import → sections read", async () => {
    const markdown = [
      "# Competitive Research Plan",
      "",
      "Top-level intro.",
      "",
      "## Competitor Categories",
      "",
      "Category details here.",
      "",
      "## Key Differentiators to Investigate",
      "",
      "Differentiator details.",
      "",
      "### Pricing Analysis",
      "",
      "Pricing info.",
      "",
      "### Feature Comparison",
      "",
      "Feature info.",
      "",
      "## Video Ideas",
      "",
      "Video stuff.",
      "",
    ].join("\n");

    const docPath = "import7/competitive-analysis-plan.md";

    const { id } = await importFilesToProposal(
      [{ docPath, content: markdown }],
      writer,
      "Deep nested import test",
    );

    const { readProposal } = await import("../../storage/proposal-repository.js");
    const freshProposal = await readProposal(id);
    const scores: Record<string, number> = {};
    for (const s of freshProposal.sections) {
      scores[SectionRef.fromTarget(s).globalKey] = 0;
    }
    await commitProposalToCanonical(id, scores);

    const sessionDocsContentRoot = getSessionDocsContentRoot();
    const overlay = new ContentLayer(sessionDocsContentRoot, new ContentLayer(getContentRoot()));

    const allContent = await overlay.readAllSections(docPath);
    expect(allContent.size).toBeGreaterThanOrEqual(5);
  });

  it("many files with deep nesting imported at once", async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      docPath: `import-bulk/doc-${i}.md`,
      content: [
        `# Document ${i}`,
        "",
        `Intro for doc ${i}.`,
        "",
        `## Section A of ${i}`,
        "",
        `Content A ${i}.`,
        "",
        `### Subsection A1 of ${i}`,
        "",
        `Subsection content A1 ${i}.`,
        "",
        `## Section B of ${i}`,
        "",
        `Content B ${i}.`,
        "",
      ].join("\n"),
    }));

    const { id } = await importFilesToProposal(files, writer, "Bulk import test");

    const { readProposal } = await import("../../storage/proposal-repository.js");
    const freshProposal = await readProposal(id);
    const scores: Record<string, number> = {};
    for (const s of freshProposal.sections) {
      scores[SectionRef.fromTarget(s).globalKey] = 0;
    }
    await commitProposalToCanonical(id, scores);

    const contentRoot = getContentRoot();
    const sessionDocsContentRoot = getSessionDocsContentRoot();
    const overlay = new ContentLayer(sessionDocsContentRoot, new ContentLayer(contentRoot));

    for (const file of files) {
      const allContent = await overlay.readAllSections(file.docPath);
      expect(allContent.size).toBeGreaterThanOrEqual(4);
    }
  });

  it("reimport of content directory (with .sections/ artifacts) corrupts documents", async () => {
    // First: import a normal document
    const markdown = [
      "# Analysis Report",
      "",
      "Report intro.",
      "",
      "## Findings",
      "",
      "Finding details.",
      "",
      "## Recommendations",
      "",
      "Recommendation details.",
      "",
    ].join("\n");

    const docPath = "reimport-test/report.md";

    const { id: firstId } = await importFilesToProposal(
      [{ docPath, content: markdown }],
      writer,
      "First import",
    );

    const { readProposal } = await import("../../storage/proposal-repository.js");
    let freshProposal = await readProposal(firstId);
    let scores: Record<string, number> = {};
    for (const s of freshProposal.sections) {
      scores[SectionRef.fromTarget(s).globalKey] = 0;
    }
    await commitProposalToCanonical(firstId, scores);

    // Read the canonical content to see what files exist
    const contentRoot = getContentRoot();
    const skeletonPath = join(contentRoot, docPath);
    const skeletonContent = await readFile(skeletonPath, "utf8");
    expect(skeletonContent).toContain("{{section:");

    // Gather all canonical files for this document
    const sectionsDir = `${skeletonPath}.sections`;
    const sectionFiles = await readdir(sectionsDir);

    // Simulate: user copies the CONTENT DIRECTORY (including .sections/) into staging
    // The skeleton file (with {{section:}} markers) AND section body files both get imported
    const reimportFiles = [
      { docPath, content: skeletonContent },
      ...await Promise.all(
        sectionFiles.map(async (f) => ({
          docPath: `reimport-test/report.md.sections/${f}`,
          content: await readFile(join(sectionsDir, f), "utf8"),
        })),
      ),
    ];

    console.log("=== Reimport files:", reimportFiles.map(f => ({ docPath: f.docPath, contentPreview: f.content.substring(0, 80) })));

    const { id: secondId } = await importFilesToProposal(
      reimportFiles,
      writer,
      "Reimport (simulating cp -r of content dir)",
    );

    freshProposal = await readProposal(secondId);
    scores = {};
    for (const s of freshProposal.sections) {
      scores[SectionRef.fromTarget(s).globalKey] = 0;
    }
    await commitProposalToCanonical(secondId, scores);

    // NOW try to read — this is where the bug manifests
    const sessionDocsContentRoot = getSessionDocsContentRoot();
    const overlay = new ContentLayer(sessionDocsContentRoot, new ContentLayer(contentRoot));

    const allContent = await overlay.readAllSections(docPath);
    expect(allContent.size).toBeGreaterThan(0);

    const assembled = await readAssembledDocument(docPath);
    expect(assembled).toContain("Report intro.");
    expect(assembled).toContain("Finding details.");
  });
});
