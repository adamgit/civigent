import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";

describe("section upsert runtime result contract", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("plain body write reports no structure change and no live reload requirement", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    const result = await overlay.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      "Overview",
      "## Overview\n\nUpdated overview body only.",
      { contentIsFullMarkdown: true },
    );

    expect(result.writtenEntries.map((entry) => entry.headingPath)).toEqual([["Overview"]]);
    expect(result.removedEntries).toEqual([]);
    expect(result.fragmentKeyRemaps).toEqual([]);
    expect(result.liveReloadEntries.map((entry) => entry.headingPath)).toEqual([["Overview"]]);
    expect(result.structureChanges).toEqual([]);
  });

  it("heading deletion reports deleted target separately from merge-target reload", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    const result = await overlay.upsertSectionMergingToPrevious(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      "Overview body after heading deletion.",
    );

    expect(result.removedEntries.map((entry) => entry.headingPath)).toEqual([["Overview"]]);
    expect(result.liveReloadEntries.map((entry) => entry.headingPath)).toEqual([[]]);
    expect(result.structureChanges[0]?.oldEntry.headingPath).toEqual(["Overview"]);
    expect(result.structureChanges[0]?.newEntries).toEqual([]);

    const rootBody = await overlay.readSection(new SectionRef(SAMPLE_DOC_PATH, []));
    expect(rootBody).toContain("Overview body after heading deletion.");
  });

  it("section split reports all successor entries as both written and live reload targets", async () => {
    const overlay = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);

    const result = await overlay.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, ["Overview"]),
      "Overview",
      [
        "## Overview",
        "",
        "Overview body after split.",
        "",
        "## Follow Up",
        "",
        "Follow up body after split.",
      ].join("\n"),
      { contentIsFullMarkdown: true },
    );

    expect(result.removedEntries.map((entry) => entry.headingPath)).toEqual([["Overview"]]);
    expect(result.writtenEntries.map((entry) => entry.headingPath)).toEqual([
      ["Overview"],
      ["Follow Up"],
    ]);
    expect(result.liveReloadEntries.map((entry) => entry.headingPath)).toEqual([
      ["Overview"],
      ["Follow Up"],
    ]);
    expect(result.structureChanges[0]?.oldEntry.headingPath).toEqual(["Overview"]);
    expect(result.structureChanges[0]?.newEntries.map((entry) => entry.headingPath)).toEqual([
      ["Overview"],
      ["Follow Up"],
    ]);

    const assembled = await new ContentLayer(ctx.contentDir).readAssembledDocument(SAMPLE_DOC_PATH);
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## Follow Up");
    expect(assembled).toContain("Follow up body after split.");
  });
});
