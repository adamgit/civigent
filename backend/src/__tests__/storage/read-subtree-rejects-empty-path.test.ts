import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentLayer } from "../../storage/content-layer.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

/**
 * ContentLayer.readSubtree(docPath, []) locates the before-first-heading
 * node through the same heading-path lookup as every other heading path and
 * returns its subtree — it is not whole-document enumeration.
 */
describe("ContentLayer.readSubtree — empty headingPath", () => {
  let ctx: TempDataRootContext;
  const DOC = "/subtree-empty-path.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    const skeletonPath = join(ctx.contentDir, DOC);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });
    const skeleton = [
      "{{section: --before-first-heading--subtree-empty.md}}",
      "",
      "# A",
      "{{section: a.md}}",
      "",
    ].join("\n");
    await writeFile(skeletonPath, skeleton, "utf8");
    await writeFile(join(sectionsDir, "--before-first-heading--subtree-empty.md"), "Intro body.", "utf8");
    await writeFile(join(sectionsDir, "a.md"), "# A\n\nA body.\n", "utf8");
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("readSubtree(docPath, ['A']) returns the subtree at A", async () => {
    const layer = new ContentLayer(ctx.contentDir);
    const entries = await layer.readSubtree(DOC, ["A"]);
    expect(entries.length).toBe(1);
    expect(entries[0].heading).toBe("A");
    expect(entries[0].headingPath).toEqual(["A"]);
    expect(entries[0].bodyContent).toContain("A body.");
  });

  it("readSubtree(docPath, []) returns only the before-first-heading entry", async () => {
    const layer = new ContentLayer(ctx.contentDir);
    const entries = await layer.readSubtree(DOC, []);
    expect(entries.length).toBe(1);
    expect(entries[0].headingPath).toEqual([]);
    expect(entries[0].heading).toBe("");
    expect(entries[0].bodyContent).toContain("Intro body.");
  });
});
