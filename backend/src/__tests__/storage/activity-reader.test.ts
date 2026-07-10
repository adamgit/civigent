import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readActivity } from "../../storage/activity-reader.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument } from "../helpers/sample-content.js";

describe("activity-reader", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("readActivity returns an array of activity items", async () => {
    const items = await readActivity(20, 365);
    expect(Array.isArray(items)).toBe(true);
    // With no committed proposals, the array should be empty
    expect(items).toHaveLength(0);
  });

  it("readActivity respects limit parameter", async () => {
    const items = await readActivity(0, 365);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(0);
  });
});
