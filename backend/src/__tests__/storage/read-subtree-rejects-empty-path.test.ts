import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentLayer } from "../../storage/content-layer.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

/**
 * ContentLayer.readSubtree rejects an empty headingPath.
 *
 * `[]` used to mean "whole document" — an overload that confused callers and
 * masked bugs. Whole-document enumeration goes through
 * `readAllSubtreeEntries(docPath)`; before-first-heading reads go through
 * `readSection(ref(docPath, []))`. These tests lock in the rejection
 * behavior and prove the proper subtree path still works.
 */
describe("ContentLayer.readSubtree — empty headingPath rejection", () => {
  let ctx: TempDataRootContext;
  const DOC = "subtree-reject.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    const skeletonPath = join(ctx.contentDir, DOC);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });
    const skeleton = [
      "{{section: --before-first-heading--subtree-reject.md}}",
      "",
      "# A",
      "{{section: a.md}}",
      "",
    ].join("\n");
    await writeFile(skeletonPath, skeleton, "utf8");
    await writeFile(join(sectionsDir, "--before-first-heading--subtree-reject.md"), "", "utf8");
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

  it("readSubtree(docPath, []) throws and the message names readAllSubtreeEntries", async () => {
    const layer = new ContentLayer(ctx.contentDir);
    await expect(layer.readSubtree(DOC, [])).rejects.toThrow(/readAllSubtreeEntries/);
  });
});
