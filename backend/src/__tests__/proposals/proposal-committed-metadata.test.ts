/**
 * Persisted commit/audit metadata that protects public behavior (spec 02 §3
 * "Key fields in the stored proposal record"; spec 12 §Data Shapes).
 *
 * A committed proposal record must durably carry:
 *  - `committed_head` = the canonical commit SHA actually written (matches git HEAD);
 *  - writer identity (id + type);
 *  - the claimed target/section metadata;
 *  - committed human-involvement metadata that, for a human publish, is EMPTY —
 *    no fabricated per-section score details.
 *
 * The action runs through the real proposal commit API; metadata is then read
 * back from the authoritative stored record. No low-value unique-ID / transient
 * listing microtests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { readProposal } from "../../storage/proposal-repository.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";

describe("persisted committed proposal metadata (spec 02 §3 / spec 12)", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;

  beforeEach(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("records committed_head, writer, targets, and EMPTY human-involvement metadata for a human commit", async () => {
    const writerToken = authFor("metadata-human", "human");

    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({
        intent: "Publish the overview",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Committed overview body.\n" }],
      });
    expect(create.status).toBe(201);
    const proposalId = create.body.proposal_id;

    const acquire = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/acquire-locks`)
      .set("Authorization", writerToken);
    expect(acquire.body.acquired).toBe(true);

    const commit = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/commit`)
      .set("Authorization", writerToken);
    expect(commit.status).toBe(200);
    expect(commit.body.status).toBe("committed");

    const stored = await readProposal(proposalId);
    expect(stored.status).toBe("committed");

    // committed_head matches the canonical commit SHA actually written.
    const head = await getHeadSha(ctx.dataCtx.rootDir);
    const committedHead = (stored as { committed_head?: string }).committed_head;
    expect(committedHead).toBe(head);
    expect(commit.body.committed_head).toBe(head);

    // Writer identity is persisted.
    expect(stored.writer.id).toBe("metadata-human");
    expect(stored.writer.type).toBe("human");

    // Target/section metadata is persisted (the claimed section).
    const keys = stored.sections.map((s) => SectionRef.headingKey(s.heading_path));
    expect(keys).toContain(SectionRef.headingKey(["Overview"]));

    // Human-involvement committed metadata is EMPTY — no fabricated per-section
    // score details for a human publish.
    const hi = (stored as { humanInvolvement_at_commit?: Record<string, number> }).humanInvolvement_at_commit;
    expect(hi).toEqual({});
  });
});
