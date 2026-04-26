import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { publishUnpublishedSections } from "../../storage/auto-commit.js";

describe("manual publish", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns not committed when no dirty sections exist", async () => {
    const result = await publishUnpublishedSections(
      { id: "human-test", type: "human", displayName: "Test", email: "test@test.local" },
    );
    expect(result.committed).toBe(false);
  });
});
