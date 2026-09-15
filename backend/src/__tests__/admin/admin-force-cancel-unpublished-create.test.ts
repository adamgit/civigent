/**
 * Canary: force-cancel success is withdraw, not live layout.
 *
 * An unpublished create lives only in the proposal overlay. After withdraw the
 * admin route still asks resolvePersistedSectionLayout for canonical layout.
 * That must not be allowed to fail the request.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { pathExists } from "../../storage/fs-primitives.js";
import { resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { DocPath } from "../../types/shared.js";

const DOC = "/force-cancel-unpublished-create.md";

describe("POST /api/admin/proposals/:id/force-cancel — unpublished create", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns 200 withdrawn when the proposal document has no canonical skeleton", async () => {
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Unpublished create for force-cancel canary",
        sections: [
          {
            doc_path: DOC,
            heading_path: ["Overview"],
            content: "Overlay-only body.\n",
          },
        ],
      });

    expect(create.status).toBe(201);
    const proposalId = create.body.proposal_id as string;
    expect(proposalId).toBeDefined();

    const before = await request(ctx.app)
      .get(`/api/proposals/${proposalId}`)
      .set("Authorization", ctx.humanToken);
    expect(before.status).toBe(200);
    expect(before.body.proposal.sections.length).toBeGreaterThan(0);
    expect(
      await pathExists(resolveSkeletonPath(DocPath.parse(DOC), ctx.dataCtx.contentDir)),
    ).toBe(false);

    const res = await request(ctx.app)
      .post(`/api/admin/proposals/${proposalId}/force-cancel`)
      .set("Authorization", ctx.humanToken)
      .send({ reason: "Force-cancel unpublished create canary." });

    expect(res.status).toBe(200);
    expect(res.body.proposal_id).toBe(proposalId);
    expect(res.body.status).toBe("withdrawn");

    const after = await request(ctx.app)
      .get(`/api/proposals/${proposalId}`)
      .set("Authorization", ctx.humanToken);
    expect(after.status).toBe(200);
    expect(after.body.proposal.status).toBe("withdrawn");
  });
});
