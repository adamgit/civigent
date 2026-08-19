import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";

function sseDoneFrameBody(sseText: string): Record<string, unknown> {
  for (const block of sseText.split("\n\n")) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    }
    if (event === "done") return JSON.parse(data) as Record<string, unknown>;
  }
  throw new Error(`No done frame in SSE commit response: ${sseText}`);
}

describe("uppercase .MD upload commits as lowercase .md (extension normalization law)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("stages NOTES.MD and commits it as /ops/NOTES.md", async () => {
    const created = await request(ctx.app)
      .post("/api/imports")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ target_folder: "/ops" });
    expect(created.status).toBe(201);
    const importId = created.body.import_id as string;

    const uploaded = await request(ctx.app)
      .post(`/api/imports/${importId}/upload`)
      .set("Authorization", ctx.humanToken)
      .attach("files", Buffer.from("# Notes\n\nBody of notes.\n", "utf8"), "NOTES.MD");
    expect(uploaded.status).toBe(200);

    const committed = await request(ctx.app)
      .post(`/api/imports/${importId}/commit`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ description: "Commit an uppercase-extension upload" });
    expect(committed.status).toBe(200);
    const doneBody = sseDoneFrameBody(committed.text);
    expect(doneBody.status).toBe("committed");
    expect(doneBody.outcome).toBe("accepted");

    const landed = await request(ctx.app)
      .get("/api/canonical/ops/NOTES.md")
      .set("Authorization", ctx.humanToken);
    expect(landed.status).toBe(200);

    const doubleExtension = await request(ctx.app)
      .get("/api/canonical/ops/NOTES.MD.md")
      .set("Authorization", ctx.humanToken);
    expect(doubleExtension.status).toBe(404);
  });
});
