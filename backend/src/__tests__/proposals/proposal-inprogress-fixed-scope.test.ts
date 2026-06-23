/**
 * `inprogress` proposal mutability within the FIXED locked target set
 * (spec 02 §3 Invariants 2 & 6; spec 12 lock boundary).
 *
 * Once a human proposal is `inprogress` (locks acquired):
 *  - section CONTENT inside a locked target is still editable (humans stay
 *    mutable in `inprogress`); and
 *  - the target SCOPE is fixed — the manifest route refuses to add/remove
 *    targets until locks are released and re-acquired, while a same-scope
 *    manifest update (e.g. intent) still succeeds (it is scope-fixed, not frozen).
 *
 * All mutations go through the real proposal HTTP APIs — no bypass.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("inprogress proposal mutability within fixed locked scope (spec 02 §3 Invariants 2/6)", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;
  let proposalId: string;

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Human draft locking ONLY the Overview section, then acquire locks.
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Revise the overview",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Initial overview.\n" }],
      });
    expect(create.status).toBe(201);
    proposalId = create.body.proposal_id;

    const acquired = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken);
    expect(acquired.status).toBe(200);
    expect(acquired.body.status).toBe("inprogress");
  });

  afterAll(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("allows editing section content inside the locked target while inprogress", async () => {
    const write = await request(ctx.app)
      .put(`/api/proposals/${proposalId}/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken)
      .send({ sections: [{ heading_path: ["Overview"], content: "Edited while inprogress.\n" }] });
    expect(write.status).toBe(200);

    const read = await request(ctx.app)
      .get(`/api/proposals/${proposalId}/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);
    expect(read.status).toBe(200);
    const overview = read.body.sections.find(
      (s: { heading_path: string[] }) => s.heading_path.length === 1 && s.heading_path[0] === "Overview",
    );
    expect(overview?.content).toContain("Edited while inprogress.");
  });

  it("refuses to change the target scope (add a section) while inprogress", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${proposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Revise the overview",
        targets: [
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] }, // new target → scope change
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.text).toMatch(/cannot change selected sections/i);
  });

  it("allows a same-scope manifest update (intent) while inprogress (scope-fixed, not frozen)", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${proposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Revise the overview — sharper wording",
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }], // unchanged scope
      });
    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe("inprogress");
    expect(res.body.proposal.intent).toBe("Revise the overview — sharper wording");
  });
});
