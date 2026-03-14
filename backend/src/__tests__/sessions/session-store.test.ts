import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { readAllSectionsWithOverlay } from "../../storage/session-store.js";

describe("Session Store — readAllSectionsWithOverlay", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns canonical content when no session overlay exists", async () => {
    const sections = await readAllSectionsWithOverlay(SAMPLE_DOC_PATH);
    expect(sections).toBeInstanceOf(Map);
    expect(sections.size).toBeGreaterThan(0);

    // Root section
    const rootContent = sections.get("");
    expect(rootContent).toBe(SAMPLE_SECTIONS.root);
  });

  it("includes named sections", async () => {
    const sections = await readAllSectionsWithOverlay(SAMPLE_DOC_PATH);
    const overviewContent = sections.get("Overview");
    expect(overviewContent).toBe(SAMPLE_SECTIONS.overview);
  });
});
