/**
 * Group A9: REST API Section Reads Invariant Tests
 *
 * Pre-refactor invariant tests for GET /documents/:docPath/sections.
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";

/** URL-safe doc path (no leading slash, to avoid double-slash in Express routes). */
const DOC_PATH_URL = SAMPLE_DOC_PATH.replace(/^\/+/, "");
import {
  acquireDocSession,
  destroyAllSessions,
  setSessionOverlayImportCallback,
  flushDirtyToOverlay,
} from "../../crdt/ydoc-lifecycle.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "human-test-user",
  type: "human",
  displayName: "API Test Writer",
  email: "api@test.local",
};

describe("A9: REST API Section Reads Invariants", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });
  });

  afterAll(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  // ── A9.2 ──────────────────────────────────────────────────────────
  // Run A9.2 first (no session) so we can verify baseline behavior

  it("A9.2: GET sections with no active session returns content from canonical", async () => {
    // Ensure no sessions exist
    destroyAllSessions();

    const res = await request(ctx.app)
      .get(`/api/documents/${DOC_PATH_URL}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);

    // Find Overview section
    const overview = res.body.sections.find(
      (s: any) => s.heading_path.length === 1 && s.heading_path[0] === "Overview",
    );
    expect(overview).toBeDefined();
    // Should contain the canonical content
    expect(overview.content).toContain(SAMPLE_SECTIONS.overview);
  });

  // ── A9.1 ──────────────────────────────────────────────────────────

  it("A9.1: GET sections during active session returns content from the live Y.Doc", async () => {
    // Ensure clean state
    destroyAllSessions();

    const baseHead = await getHeadSha(ctx.dataCtx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-a91",
    );

    // Find the Overview fragment key
    let overviewKey: string | null = null;
    for (const [fragmentKey, headingPath] of session.headingPathByFragmentKey) {
      const heading = headingPath[headingPath.length - 1] ?? "";
      if (heading === "Overview") {
        overviewKey = fragmentKey;
      }
    }
    expect(overviewKey).not.toBeNull();

    // Modify content in Y.Doc (live session, not flushed to disk)
    const uniqueMarker = `LIVE_YDOC_CONTENT_${Date.now()}`;
    session.liveFragments.replaceFragmentString(
      overviewKey!,
      fragmentFromRemark(`## Overview\n\n${uniqueMarker}`),
      undefined,
    );

    // Query the API — should get live content, NOT canonical
    const res = await request(ctx.app)
      .get(`/api/documents/${DOC_PATH_URL}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);

    const overview = res.body.sections.find(
      (s: any) => s.heading_path.length === 1 && s.heading_path[0] === "Overview",
    );
    expect(overview).toBeDefined();
    // The API overlays live Y.Doc content over canonical when a session is active
    expect(overview.content).toContain(uniqueMarker);

    // Clean up session
    destroyAllSessions();
  });

  // ── A9.3 ──────────────────────────────────────────────────────────

  it("A9.3: section list during active session reflects current skeleton structure", async () => {
    // Ensure clean state
    destroyAllSessions();

    const baseHead = await getHeadSha(ctx.dataCtx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-a93",
    );

    // Baseline: should have BFH, Overview, Timeline
    const res1 = await request(ctx.app)
      .get(`/api/documents/${DOC_PATH_URL}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res1.status).toBe(200);
    const headings1 = res1.body.sections.map((s: any) => s.heading_path);
    const hasOverview = headings1.some((hp: string[]) => hp.length === 1 && hp[0] === "Overview");
    const hasTimeline = headings1.some((hp: string[]) => hp.length === 1 && hp[0] === "Timeline");
    expect(hasOverview).toBe(true);
    expect(hasTimeline).toBe(true);

    // The session's heading index should match what the API returns
    const skeletonHeadings: string[][] = [];
    for (const [, headingPath] of session.headingPathByFragmentKey) {
      skeletonHeadings.push([...headingPath]);
    }

    // API section count should match session entry count
    expect(res1.body.sections.length).toBe(skeletonHeadings.length);

    // Clean up
    destroyAllSessions();
  });
});
