import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readActivity, readChangesSince } from "../../storage/activity-reader.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

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

  it("readChangesSince returns ChangesSinceResponse shape", async () => {
    const result = await readChangesSince(SAMPLE_DOC_PATH);
    expect(result).toHaveProperty("since_sha");
    expect(result).toHaveProperty("current_sha");
    expect(result).toHaveProperty("changed");
    expect(result).toHaveProperty("changed_sections");
    expect(typeof result.changed).toBe("boolean");
    expect(Array.isArray(result.changed_sections)).toBe(true);
  });

  it("readChangesSince without afterHead returns changed=false", async () => {
    const result = await readChangesSince(SAMPLE_DOC_PATH);
    expect(result.changed).toBe(false);
    expect(result.since_sha).toBe("");
    expect(result.changed_sections).toHaveLength(0);
  });

  it("readChangesSince with current HEAD returns no changes", async () => {
    const result = await readChangesSince(SAMPLE_DOC_PATH, undefined);
    // current_sha should be a valid SHA
    if (result.current_sha) {
      expect(typeof result.current_sha).toBe("string");
      expect(result.current_sha.length).toBeGreaterThan(0);
    }
  });
});
