import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { authFor } from "../helpers/auth.js";
import {
  createSampleDocument,
  SAMPLE_DOC_PATH,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";
import { gitExec } from "../../storage/git-repo.js";

const NESTED_DOC_PATH = "/nested/body-holder-api.md";

async function createNestedDocument(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, NESTED_DOC_PATH.replace(/^\/+/, ""));
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(sectionsDir, { recursive: true });

  const topSkeleton = [
    "{{section: _root.md}}",
    "",
    "## Introduction",
    "{{section: intro.md}}",
    "",
    "## Details",
    "{{section: details.md}}",
    "",
  ].join("\n");
  await writeFile(skeletonPath, topSkeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Root body.\n", "utf8");
  await writeFile(join(sectionsDir, "intro.md"), "Introduction body.\n", "utf8");

  const detailsSubSkeleton = [
    "{{section: _details_root.md}}",
    "",
    "### Sub-Detail A",
    "{{section: sub_a.md}}",
    "",
    "### Sub-Detail B",
    "{{section: sub_b.md}}",
    "",
  ].join("\n");
  const detailsSectionsDir = join(sectionsDir, "details.md.sections");
  await mkdir(detailsSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "details.md"), detailsSubSkeleton, "utf8");
  await writeFile(join(detailsSectionsDir, "_details_root.md"), "Details body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_a.md"), "Sub-detail A body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_b.md"), "Sub-detail B body.\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", "add nested body-holder api fixture",
      "--allow-empty",
    ],
    dataRoot,
  );
}

describe("GET /api/documents/:doc_path/sections", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await createNestedDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  function sectionByHeadingPath(
    sections: Array<{ heading_path: string[]; content: string }>,
    headingPath: string[],
  ): { heading_path: string[]; content: string } | undefined {
    return sections.find((section) => {
      if (section.heading_path.length !== headingPath.length) return false;
      return section.heading_path.every((segment, index) => segment === headingPath[index]);
    });
  }

  it("returns sections array", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections.length).toBeGreaterThan(0);
  });

  it("keeps existing behavior unchanged without proposal_id", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const overview = sectionByHeadingPath(res.body.sections, ["Overview"]);
    expect(overview?.content).toContain(SAMPLE_SECTIONS.overview);
  });

  it("returns proposal-overlay content when proposal_id is provided", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Manual publish draft",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Proposal-specific overview content.",
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const overview = sectionByHeadingPath(res.body.sections, ["Overview"]);
    expect(overview?.content).toContain("Proposal-specific overview content.");
  });

  it("returns CANONICAL content (not proposal-overlay) on the default GET while a proposal exists (MW-7)", async () => {
    // Canonical-only read contract: the default section-list GET (no proposal_id)
    // must NOT surface in-flight proposal/live-overlay content. Even with an open
    // proposal editing "Overview", the default read returns canonical bytes.
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Open proposal that must not leak into default reads",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "OVERLAY-ONLY content that must not appear in canonical-only reads.",
          },
        ],
      });
    expect(createRes.status).toBe(201);

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const overview = sectionByHeadingPath(res.body.sections, ["Overview"]);
    // Canonical content is returned…
    expect(overview?.content).toContain(SAMPLE_SECTIONS.overview);
    // …and the proposal-overlay content is NOT leaked into the default read.
    // (If the read reverted to a session/proposal overlay this assertion fails.)
    expect(overview?.content).not.toContain("OVERLAY-ONLY content that must not appear");
  });

  it("falls back to canonical content for untouched sections with proposal_id", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Manual publish draft fallback check",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Overlay only for overview.",
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const timeline = sectionByHeadingPath(res.body.sections, ["Timeline"]);
    expect(timeline?.content).toContain(SAMPLE_SECTIONS.timeline);
  });

  it("returns 404 for invalid proposal_id", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: "not-a-real-proposal-id" })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });

  it("returns 403 for unrelated proposal_id owned by another writer", async () => {
    const otherHumanToken = authFor("human-other-user", "human");
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", otherHumanToken)
      .send({
        intent: "Other user's draft",
        sections: [],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(403);
  });

  it("each section has heading_path, content, agentWritePolicy, word_count", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    for (const section of res.body.sections) {
      expect(section).toHaveProperty("heading_path");
      expect(section).toHaveProperty("content");
      expect(section).toHaveProperty("word_count");
      // humanInvolvement_score retired → section-level agentWritePolicy summary
      expect(section).toHaveProperty("agentWritePolicy");
      expect(typeof section.agentWritePolicy.canWrite).toBe("boolean");
    }
  });

  it("returns 404 for non-existent document", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/nonexistent.md/sections")
      .set("Authorization", ctx.humanToken);

    // Non-existent docs return 404 (no skeleton on disk)
    expect(res.status).toBe(404);
  });

  it("returns headed content for a parent section whose body lives in a body-holder child", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${NESTED_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const details = res.body.sections.find(
      (section: any) =>
        Array.isArray(section.heading_path)
        && section.heading_path.length === 1
        && section.heading_path[0] === "Details",
    );
    const subDetailA = res.body.sections.find(
      (section: any) =>
        Array.isArray(section.heading_path)
        && section.heading_path.length === 2
        && section.heading_path[0] === "Details"
        && section.heading_path[1] === "Sub-Detail A",
    );

    expect(details).toBeDefined();
    expect(details.heading).toBe("Details");
    expect(details.content).toContain("## Details");
    expect(details.content).toContain("Details body.");
    expect(details.content).not.toContain("### Sub-Detail A");
    expect(subDetailA).toBeDefined();
  });

  it("proposal-mode GET preserves headed canonical fallback for an untouched body-holder-backed parent", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Unrelated nested doc proposal",
        sections: [
          {
            doc_path: NESTED_DOC_PATH,
            heading_path: ["Introduction"],
            content: "## Introduction\n\nUpdated introduction via proposal.",
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${NESTED_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const details = res.body.sections.find(
      (section: any) =>
        Array.isArray(section.heading_path)
        && section.heading_path.length === 1
        && section.heading_path[0] === "Details",
    );

    expect(details).toBeDefined();
    expect(details.heading).toBe("Details");
    expect(details.content).toContain("## Details");
    expect(details.content).toContain("Details body.");
  });
});
