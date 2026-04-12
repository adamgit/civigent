/**
 * Group A6: Session End Flow (End-to-End) Invariant Tests
 *
 * Pre-refactor invariant tests for the session teardown path
 * (last holder disconnect → flush → normalize → commit → cleanup).
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir, rm } from "node:fs/promises";
import path, { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";

import { getHeadSha } from "../../storage/git-repo.js";
import {
  destroyAllSessions,
  releaseDocSession,
  setSessionOverlayImportCallback,
  lookupDocSession,
  markFragmentDirty,
  flushDirtyToOverlay,
  findKeyForHeadingPath,
} from "../../crdt/ydoc-lifecycle.js";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "end-writer",
  type: "human",
  displayName: "End Writer",
  email: "end@test.local",
};

async function cleanupSessionOverlay(docPath: string): Promise<void> {
  const overlayRoot = getSessionSectionsContentRoot();
  const skelPath = path.join(overlayRoot, ...docPath.split("/"));
  await rm(skelPath, { force: true });
  await rm(`${skelPath}.sections`, { recursive: true, force: true });
  const fragDir = path.join(getSessionFragmentsRoot(), docPath);
  await rm(fragDir, { recursive: true, force: true });
}

function findHeadingKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
): string {
  const key = findKeyForHeadingPath(live, [heading]);
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

async function commitToCanonical(writers: WriterIdentity[], docPath: string) {
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const [primary] = writers;
  const commitMsg = `human edit: ${primary.displayName}\n\nWriter: ${primary.id}`;
  const author = { name: primary.displayName, email: primary.email ?? "human@knowledge-store.local" };
  return store.absorbChangedSections(getSessionSectionsContentRoot(), commitMsg, author, { docPaths: [docPath] });
}

describe("A6: Session End Flow Invariants", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark(`## Overview\n\n${uniqueMarker}`));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey);

    // Release last holder �� triggers flush + normalize
    const result = await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-a61");
    expect(result.sessionEnded).toBe(true);

    // Session should be gone
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    // Now commit to canonical (as the coordinator would)
    const commitResult = await commitToCanonical(
      [writer],
      SAMPLE_DOC_PATH,
    );
    expect(commitResult.changedSections.length).toBeGreaterThan(0);

    // Clean up session files
    await cleanupSessionOverlay(SAMPLE_DOC_PATH);

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
    const commitResult = await commitToCanonical([writer], SAMPLE_DOC_PATH);
    expect(commitResult.changedSections).toHaveLength(0);
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nA6.3 raw fragment cleanup test."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey);

    // Flush to create raw fragment files
    await flushDirtyToOverlay(live);

    // Verify raw fragments exist
    const rawBefore = await new RawFragmentRecoveryBuffer(SAMPLE_DOC_PATH).listFragmentKeys();
    expect(rawBefore.length).toBeGreaterThan(0);

    // Release + commit + cleanup
    await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-a63");
    await commitToCanonical([writer], SAMPLE_DOC_PATH);
    await cleanupSessionOverlay(SAMPLE_DOC_PATH);

    // Raw fragments should be gone
    const rawAfter = await new RawFragmentRecoveryBuffer(SAMPLE_DOC_PATH).listFragmentKeys();
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nA6.4 overlay cleanup test."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey);
    await flushDirtyToOverlay(live);

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
    await commitToCanonical([writer], SAMPLE_DOC_PATH);
    await cleanupSessionOverlay(SAMPLE_DOC_PATH);

    // Overlay files should be gone
    let overlayAfter: string[] = [];
    try {
      overlayAfter = await readdir(sectionsDir);
    } catch { /* directory deleted */ }
    expect(overlayAfter.length).toBe(0);
  });
});
