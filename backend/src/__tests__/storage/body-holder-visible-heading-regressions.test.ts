import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentLayer, ProposalShadowContentLayer } from "../../storage/content-layer.js";
import { readAssembledDocument } from "../../storage/document-reader.js";
import { flattenStructureToHeadingPaths, readDocumentStructure } from "../../storage/heading-resolver.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createProposal } from "../../storage/proposal-repository.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

const DOC_PATH = "/test/body-holder-visible-heading.md";

async function createNestedDocument(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(sectionsDir, { recursive: true });

  const topSkeleton = [
    "{{section: _root.md}}",
    "",
    "## Introduction",
    "{{section: intro.md}}",
    "",
    "## Details",
    "{{section: details.md}}",
    "",
  ].join("\n");
  await writeFile(skeletonPath, topSkeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Root body.\n", "utf8");
  await writeFile(join(sectionsDir, "intro.md"), "Introduction body.\n", "utf8");

  const detailsSubSkeleton = [
    "{{section: _details_root.md}}",
    "",
    "### Sub-Detail A",
    "{{section: sub_a.md}}",
    "",
    "### Sub-Detail B",
    "{{section: sub_b.md}}",
    "",
  ].join("\n");
  const detailsSectionsDir = join(sectionsDir, "details.md.sections");
  await mkdir(detailsSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "details.md"), detailsSubSkeleton, "utf8");
  await writeFile(join(detailsSectionsDir, "_details_root.md"), "Details body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_a.md"), "Sub-detail A body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_b.md"), "Sub-detail B body.\n", "utf8");
}

describe("body-holder visible heading regressions", () => {
  let ctx: TempDataRootContext;
  let previousSnapshotEnv: string | undefined;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    previousSnapshotEnv = process.env.KS_SNAPSHOT_ENABLED;
    process.env.KS_SNAPSHOT_ENABLED = "false";
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => {
    if (previousSnapshotEnv === undefined) {
      delete process.env.KS_SNAPSHOT_ENABLED;
    } else {
      process.env.KS_SNAPSHOT_ENABLED = previousSnapshotEnv;
    }
    await ctx.cleanup();
  });

  it("readAssembledDocument keeps the parent heading visible for a body-holder-backed section", async () => {
    const assembled = await readAssembledDocument(DOC_PATH);

    const detailsHeadingIndex = assembled.indexOf("## Details");
    const detailsBodyIndex = assembled.indexOf("Details body.");
    const childHeadingIndex = assembled.indexOf("### Sub-Detail A");

    expect(detailsHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(detailsBodyIndex).toBeGreaterThan(detailsHeadingIndex);
    expect(childHeadingIndex).toBeGreaterThan(detailsBodyIndex);
  });

  it("getSectionList preserves the visible parent heading metadata for a body-holder-backed section", async () => {
    const layer = new ContentLayer(ctx.contentDir);
    const sections = await layer.getSectionList(DOC_PATH);
    const details = sections.find((section) =>
      section.headingPath.length === 1 && section.headingPath[0] === "Details",
    );

    expect(details).toBeDefined();
    expect(details?.heading).toBe("Details");
    expect(details?.headingLevel).toBe(2);
  });

  it("getSectionDiscoveryList reports the visible parent heading instead of the anonymous body-holder child", async () => {
    const layer = new ContentLayer(ctx.contentDir);
    const sections = await layer.getSectionDiscoveryList(DOC_PATH);
    const details = sections.find((section) =>
      section.headingPath.length === 1 && section.headingPath[0] === "Details",
    );

    expect(details).toBeDefined();
    expect(details?.heading).toBe("Details");
  });

  it("flattenStructureToHeadingPaths excludes structural body-holder children from the visible heading list", async () => {
    const structure = await readDocumentStructure(DOC_PATH);

    expect(flattenStructureToHeadingPaths(structure)).toEqual([
      [],
      ["Introduction"],
      ["Details"],
      ["Details", "Sub-Detail A"],
      ["Details", "Sub-Detail B"],
    ]);
  });

  it("proposal overlay readAllSections preserves canonical fallback for an untouched body-holder-backed parent after an unrelated write", async () => {
    const writer = {
      id: "agent-test",
      type: "agent" as const,
      displayName: "Test Agent",
    };
    const { contentRoot } = await createProposal(
      writer,
      "Body-holder fallback regression",
      [{ doc_path: DOC_PATH, heading_path: ["Introduction"] }],
    );
    const overlay = new ProposalShadowContentLayer(contentRoot, ctx.contentDir, async () => new Set<string>());

    await overlay.upsertSection(
      new SectionRef(DOC_PATH, ["Introduction"]),
      "Introduction",
      "## Introduction\n\nUpdated introduction via proposal.",
      { expandHeadingsIntoSections: true },
    );

    const sections = await overlay.readAllSections(DOC_PATH);
    expect(sections.get("Introduction")).toBe("Updated introduction via proposal.");
    expect(sections.get("Details")).toBe("Details body.");
  });
});
