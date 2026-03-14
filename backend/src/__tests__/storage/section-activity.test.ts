import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readDocSectionCommitInfo, getSecondsSinceLastHumanActivity } from "../../storage/section-activity.js";
import { SectionRef } from "../../domain/section-ref.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("section-activity", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("readDocSectionCommitInfo returns a Map with entries for committed sections", async () => {
    const result = await readDocSectionCommitInfo(SAMPLE_DOC_PATH, 3);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBeGreaterThanOrEqual(1);

    for (const [, info] of result) {
      expect(info).toHaveProperty("timestampMs");
      expect(info).toHaveProperty("sha");
      expect(typeof info.timestampMs).toBe("number");
      expect(typeof info.sha).toBe("string");
    }
  });

  it("readDocSectionCommitInfo keys are relative file paths", async () => {
    const result = await readDocSectionCommitInfo(SAMPLE_DOC_PATH, 3);

    for (const key of result.keys()) {
      expect(typeof key).toBe("string");
      // Keys should be relative paths within content/
      expect(key).toContain("content/");
    }
  });

  it("readDocSectionCommitInfo timestamp is recent (within last minute)", async () => {
    const result = await readDocSectionCommitInfo(SAMPLE_DOC_PATH, 3);
    const now = Date.now();

    for (const [, info] of result) {
      // The commit was just made in beforeAll
      const ageMs = now - info.timestampMs;
      expect(ageMs).toBeLessThan(60_000);
    }
  });

  it("getSecondsSinceLastHumanActivity returns a number or null", async () => {
    const commitInfo = await readDocSectionCommitInfo(SAMPLE_DOC_PATH, 3);
    const result = await getSecondsSinceLastHumanActivity(new SectionRef(SAMPLE_DOC_PATH, ["Overview"]), commitInfo);

    if (result !== null) {
      expect(typeof result).toBe("number");
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it("getSecondsSinceLastHumanActivity returns null for non-existent section", async () => {
    const result = await getSecondsSinceLastHumanActivity(new SectionRef(SAMPLE_DOC_PATH, ["Nonexistent"]), new Map());
    expect(result).toBeNull();
  });
});
