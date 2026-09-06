import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SectionRef } from "../../domain/section-ref.js";
import { ProposalShadowContentLayer } from "../../storage/content-layer.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import {
  createSampleDocument,
  SAMPLE_DOC_PATH,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import {
  createTempDataRoot,
  type TempDataRootContext,
} from "../helpers/temp-data-root.js";

describe("BFH section write uses ordinary subtree replacement", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("promotes headings while preserving the BFH and unrelated root siblings", async () => {
    const layer = new ProposalShadowContentLayer(ctx.contentDir, ctx.contentDir);
    const before = await layer.getSectionList(SAMPLE_DOC_PATH);
    const sectionFileBefore = new Map(
      before.map((entry) => [JSON.stringify(entry.headingPath), entry.sectionFile]),
    );

    const result = await layer.upsertSection(
      new SectionRef(SAMPLE_DOC_PATH, []),
      "",
      sectionWriteInputFromExternal(
        "Updated preamble.\n\n## Added\n\nAdded section body.",
      ),
    );

    const after = await layer.getSectionList(SAMPLE_DOC_PATH);
    expect(after.map((entry) => entry.headingPath)).toEqual([
      [],
      ["Added"],
      ["Overview"],
      ["Timeline"],
    ]);

    expect(after.find((entry) => entry.headingPath.length === 0)?.sectionFile)
      .toBe(sectionFileBefore.get(JSON.stringify([])));
    for (const headingPath of [["Overview"], ["Timeline"]]) {
      expect(
        after.find(
          (entry) =>
            JSON.stringify(entry.headingPath) === JSON.stringify(headingPath),
        )?.sectionFile,
      ).toBe(sectionFileBefore.get(JSON.stringify(headingPath)));
    }

    expect(await layer.readSection(new SectionRef(SAMPLE_DOC_PATH, [])))
      .toBe("Updated preamble.");
    expect(
      await layer.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Added"])),
    ).toBe("Added section body.");
    expect(
      await layer.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Overview"])),
    ).toBe(SAMPLE_SECTIONS.overview);
    expect(
      await layer.readSection(new SectionRef(SAMPLE_DOC_PATH, ["Timeline"])),
    ).toBe(SAMPLE_SECTIONS.timeline);

    expect(result.writtenEntries.map((entry) => entry.headingPath)).toEqual(
      expect.arrayContaining([[], ["Added"]]),
    );
  });

});
