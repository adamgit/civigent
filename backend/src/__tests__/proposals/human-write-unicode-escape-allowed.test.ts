/**
 * The prose-escape guard is the AGENT tool surface only. A human writing through
 * the REST proposal API may store any character sequence, including a literal
 * `\uXXXX`.
 *
 * This test exists to keep the guard out of the shared write primitives. Both
 * `POST /api/proposals` (this test) and the CRDT quiescence settle path go
 * through `sectionWriteInputFromExternal` / `ProposalEditor`; a check installed
 * there would reject human editor content, and on the settle leg a throw routes
 * through `handleProcessFatal` — a human typing an escape sequence, or merely
 * splitting a section that already contains one, would wedge publishing.
 *
 * Unlike its two siblings this one is GREEN today and must stay green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

/** Six literal characters: backslash, u, 2, 0, 1, 3 — NOT an en-dash. */
const ESCAPE_TOKEN = "\\u2013";

describe("human REST proposal writes are not subject to the agent escape guard", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("accepts a literal escape sequence in prose and stores it verbatim", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human documents a broken client payload",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: `The client sent 02${ESCAPE_TOKEN}09 instead of an en-dash.\n`,
          },
        ],
      });

    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id;

    const readRes = await request(ctx.app).get(`/api/proposals/${proposalId}`);
    expect(readRes.status).toBe(200);
    const section = readRes.body.proposal.sections.find(
      (s: { heading_path: string[] }) => s.heading_path[0] === "Overview",
    );
    expect(section.content).toContain(ESCAPE_TOKEN);
  });
});
