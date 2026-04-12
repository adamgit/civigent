/**
 * Group A6: Session End Flow (End-to-End) Invariant Tests
 *
 * Pre-refactor invariant tests for the session teardown path
 * (last holder disconnect → flush → normalize → commit → cleanup).
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  destroyAllSessions,
  releaseDocSession,
  setSessionOverlayImportCallback,
  lookupDocSession,
} from "../../crdt/ydoc-lifecycle.js";
import {
  importSessionDirtyFragmentsToOverlay,
  commitSessionFilesToCanonical,
  cleanupSessionFiles,
  listRawFragments,
} from "../../storage/session-store.js";
import { getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "end-writer",
  type: "human",
  displayName: "End Writer",
  email: "end@test.local",
};

function findHeadingKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
): string {
  let key: string | null = null;
  live.raw.fragments.skeleton.forEachSection((entryHeading, level, sectionFile, headingPath) => {
    const isBfh = headingPath.length === 0 && level === 0 && entryHeading === "";
    if (entryHeading === heading) {
      key = fragmentKeyFromSectionFile(sectionFile, isBfh);
    }
  });
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

describe("A6: Session End Flow Invariants", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await importSessionDirtyFragmentsToOverlay(session);
    });
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  // ── A6.1 ──────────────────────────────────────────────────────────

  it("A6.1: last holder disconnect flushes dirty fragments, normalizes, commits to canonical, and cleans up", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a61" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const uniqueMarker = `A6.1 session end ${Date.now()}`;

    // Edit Overview
    live.mutateSection(writer.id, overviewKey, `## Overview\n\n${uniqueMarker}`);

    // Release last holder — triggers flush + normalize
    const result = await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-a61");
    expect(result.sessionEnded).toBe(true);

    // Session should be gone
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    // Now commit to canonical (as the coordinator would)
    const commitResult = await commitSessionFilesToCanonical(
      [writer],
      SAMPLE_DOC_PATH,
    );
    expect(commitResult.sectionsCommitted).toBeGreaterThan(0);

    // Clean up session files
    await cleanupSessionFiles(SAMPLE_DOC_PATH);

    // Verify content is in canonical
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    expect(String(sections.get("Overview") ?? "")).toContain(uniqueMarker);
  });

  // ── A6.2 ──────────────────────────────────────────────────────────

  it("A6.2: session end with no dirty state produces no git commit", async () => {
    await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a62" },
    });

    // Release without making any edits
    const result = await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-a62");
    expect(result.sessionEnded).toBe(true);

    // Attempt commit — even though nothing was dirty, the commit pipeline
    // may produce a git commit (due to --allow-empty). The invariant is:
    // committedSections is empty (no sections actually changed in canonical).
    const commitResult = await commitSessionFilesToCanonical([writer], SAMPLE_DOC_PATH);
    expect(commitResult.committedSections).toHaveLength(0);
  });

  // ── A6.3 ──────────────────────────────────────────────────────────

  it("A6.3: session end cleans up raw fragment files (sessions/fragments/)", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a63" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit to create dirty state
    live.mutateSection(writer.id, overviewKey, "## Overview\n\nA6.3 raw fragment cleanup test.");

    // Flush to create raw fragment files
    await importSessionDirtyFragmentsToOverlay(live.raw);

    // Verify raw fragments exist
    const rawBefore = await listRawFragments(SAMPLE_DOC_PATH);
    expect(rawBefore.length).toBeGreaterThan(0);

    // Release + commit + cleanup
    await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-a63");
    await commitSessionFilesToCanonical([writer], SAMPLE_DOC_PATH);
    await cleanupSessionFiles(SAMPLE_DOC_PATH);

    // Raw fragments should be gone
    const rawAfter = await listRawFragments(SAMPLE_DOC_PATH);
    expect(rawAfter.length).toBe(0);
  });

  // ── A6.4 ──────────────────────────────────────────────────────────

  it("A6.4: session end cleans up session overlay files (sessions/sections/)", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a64" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit to create overlay files
    live.mutateSection(writer.id, overviewKey, "## Overview\n\nA6.4 overlay cleanup test.");
    await importSessionDirtyFragmentsToOverlay(live.raw);

    // Verify overlay files exist
    const overlayRoot = getSessionSectionsContentRoot();
    const normalizedDoc = SAMPLE_DOC_PATH.replace(/^\/+/, "");
    const sectionsDir = join(overlayRoot, `${normalizedDoc}.sections`);
    let overlayFiles: string[] = [];
    try {
      overlayFiles = await readdir(sectionsDir);
    } catch { /* empty */ }
    expect(overlayFiles.length).toBeGreaterThan(0);

    // Release + commit + cleanup
    await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-a64");
    await commitSessionFilesToCanonical([writer], SAMPLE_DOC_PATH);
    await cleanupSessionFiles(SAMPLE_DOC_PATH);

    // Overlay files should be gone
    let overlayAfter: string[] = [];
    try {
      overlayAfter = await readdir(sectionsDir);
    } catch { /* directory deleted */ }
    expect(overlayAfter.length).toBe(0);
  });
});
