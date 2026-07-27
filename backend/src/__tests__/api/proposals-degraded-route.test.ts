/**
 * `GET /api/proposals/degraded` surface — committed `empty-committed` proposals.
 *
 * A committed zero-claim proposal (`sections: []`, `targets: []`) is terminal
 * corruption: the decoder tags it `degraded: ["empty-committed"]` and the degraded
 * surface must expose it for audit/recovery investigation. An empty draft is valid
 * draft state (not corruption) and a healthy committed proposal is not degraded —
 * neither may appear on this surface.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { getProposalsCommittedRoot } from "../../storage/data-root.js";

describe("GET /api/proposals/degraded — empty-committed surface", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;
  let healthyCommittedId: string;
  let emptyDraftId: string;
  const emptyCommittedId = "prop-empty-committed";

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // (1) A committed zero-claim proposal planted on disk exactly as a previous bad
    // implementation would leave it — `sections: []` and an explicitly-written
    // `targets: []`. The decoder must classify it `empty-committed` on read.
    const committedDir = join(getProposalsCommittedRoot(), emptyCommittedId);
    await mkdir(committedDir, { recursive: true });
    await writeFile(
      join(committedDir, "meta.json"),
      JSON.stringify(
        {
          id: emptyCommittedId,
          writer: { id: ctx.agentId, type: "agent", displayName: "Agent" },
          intent: "empty committed corruption",
          sections: [],
          targets: [],
          created_at: "2025-01-01T00:00:00.000Z",
          committed_head: "deadbeef",
          humanInvolvement_at_commit: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    // (2) A healthy committed agent proposal (real section claim, committed via API).
    const healthyRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "healthy committed",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Healthy body.\n" }],
      });
    healthyCommittedId = healthyRes.body.proposal_id;
    const commitRes = await request(ctx.app)
      .post(`/api/proposals/${healthyCommittedId}/commit`)
      .set("Authorization", ctx.agentToken);
    expect(commitRes.body.status).toBe("committed");

    // (3) An empty human draft — valid draft state, NOT corruption.
    const draftRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({ intent: "empty draft", sections: [] });
    expect(draftRes.body.status).toBe("draft");
    emptyDraftId = draftRes.body.proposal_id;
  });

  afterAll(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("returns the committed empty-committed proposal and excludes empty drafts + healthy committed", async () => {
    const res = await request(ctx.app)
      .get("/api/proposals/degraded")
      .set("Authorization", ctx.humanToken);
    expect(res.status).toBe(200);

    const proposals = res.body.proposals as Array<{
      id: string;
      status: string;
      sections: unknown[];
      targets: unknown[];
      degraded?: string[];
    }>;
    const byId = new Map(proposals.map((p) => [p.id, p]));

    const emptyCommitted = byId.get(emptyCommittedId);
    expect(emptyCommitted).toBeDefined();
    expect(emptyCommitted!.status).toBe("committed");
    expect(emptyCommitted!.sections).toEqual([]);
    expect(emptyCommitted!.targets).toEqual([]);
    expect(emptyCommitted!.degraded).toEqual(["empty-committed"]);

    // An empty draft is valid draft state — never on the degraded surface.
    expect(byId.has(emptyDraftId)).toBe(false);
    // A healthy committed proposal carries no degraded marker — excluded.
    expect(byId.has(healthyCommittedId)).toBe(false);

    // Every returned proposal genuinely carries a degraded marker.
    expect(proposals.every((p) => (p.degraded ?? []).length > 0)).toBe(true);
    expect(res.body.undecodable).toEqual([]);
  });
});
