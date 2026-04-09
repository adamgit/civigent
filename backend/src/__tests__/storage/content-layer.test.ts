import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

/**
 * Tests for writeSection's heading-stripping invariant.
 * The stripping logic is internal to writeSection — tested here via the public API.
 *
 * Cases that include wrong-level or wrong-heading content are not tested here because
 * writeSection rejects multi-heading content (MultiSectionContentError) before stripping
 * applies. Those edge cases only arise from direct internal use, not the public API.
 */
describe("writeSection heading-stripping invariant", () => {
  let ctx: TempDataRootContext;
  const DOC = "strip-test.md";

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    // Build a skeleton via raw file I/O so each entry retains its intended heading
    // level: BFH + "Overview" (h2) + "Title" (h1) + "Deep Section" (h4). The skeleton
    // entries within a single file are siblings (nesting is by sub-skeleton files,
    // not heading-level numbers — see document-skeleton.ts:1554), so flat mixed
    // levels are valid. The level recorded per entry is what writeSection passes
    // into stripHeadingFromFragment, so the intended heading-stripping behavior
    // depends on getting these levels right.
    const skeletonPath = join(ctx.contentDir, DOC);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });
    const skeleton = [
      "{{section: --before-first-heading--strip-test.md}}",
      "",
      "## Overview",
      "{{section: overview.md}}",
      "",
      "# Title",
      "{{section: title.md}}",
      "",
      "#### Deep Section",
      "{{section: deep-section.md}}",
      "",
    ].join("\n");
    await writeFile(skeletonPath, skeleton, "utf8");
    // Empty body files so writeSection's path resolution finds them on disk;
    // each test overwrites the relevant file via writeAndRead before reading.
    await writeFile(join(sectionsDir, "--before-first-heading--strip-test.md"), "", "utf8");
    await writeFile(join(sectionsDir, "overview.md"), "", "utf8");
    await writeFile(join(sectionsDir, "title.md"), "", "utf8");
    await writeFile(join(sectionsDir, "deep-section.md"), "", "utf8");
  });

  afterAll(async () => { await ctx.cleanup(); });

  async function writeAndRead(headingPath: string[], content: string): Promise<string> {
    const layer = new ContentLayer(ctx.contentDir);
    await layer.writeSection(new SectionRef(DOC, headingPath), content);
    return layer.readSection(new SectionRef(DOC, headingPath));
  }

  it("strips matching h2 heading and blank lines after it", async () => {
    const result = await writeAndRead(["Overview"], "## Overview\n\nThis is the body.");
    expect(result).toBe("This is the body.");
  });

  it("strips matching heading with no body after it", async () => {
    const result = await writeAndRead(["Overview"], "## Overview");
    expect(result).toBe("");
  });

  it("strips matching heading with multiple blank lines", async () => {
    const result = await writeAndRead(["Overview"], "## Overview\n\n\n\nBody text.");
    expect(result).toBe("Body text.");
  });

  it("passes through body-only content unchanged", async () => {
    const result = await writeAndRead(["Overview"], "This is already body-only content.\n\nWith paragraphs.");
    expect(result).toBe("This is already body-only content.\n\nWith paragraphs.");
  });

  it("passes through root section content unchanged (root sections have no heading)", async () => {
    const result = await writeAndRead([], "Root body content.");
    expect(result).toBe("Root body content.");
  });

  it("passes through empty content unchanged", async () => {
    const result = await writeAndRead(["Overview"], "");
    expect(result).toBe("");
  });

  it("strips h1 headings", async () => {
    const result = await writeAndRead(["Title"], "# Title\n\nBody.");
    expect(result).toBe("Body.");
  });

  it("strips h4 headings", async () => {
    const result = await writeAndRead(["Deep Section"], "#### Deep Section\n\nNested body.");
    expect(result).toBe("Nested body.");
  });
});
