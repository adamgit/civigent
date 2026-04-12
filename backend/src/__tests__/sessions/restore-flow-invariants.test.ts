/**
 * Group A10: Restore Flow (End-to-End) Invariant Tests
 *
 * Pre-refactor invariant tests for the document restore path.
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { preemptiveImportNormalizeAndCommit } from "../../storage/auto-commit.js";
import {
  destroyAllSessions,
  setSessionOverlayImportCallback,
  lookupDocSession,
  invalidateSessionForRestore,
  setBroadcastRestoreInvalidation,
  addContributor,
} from "../../crdt/ydoc-lifecycle.js";
import {
  importSessionDirtyFragmentsToOverlay,
  listRawFragments,
} from "../../storage/session-store.js";
import { getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import type { WriterIdentity } from "../../types/shared.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const writerA: WriterIdentity = {
  id: "restore-writer-a",
  type: "human",
  displayName: "Restore Writer A",
  email: "restore-a@test.local",
};

const writerB: WriterIdentity = {
  id: "restore-writer-b",
  type: "human",
  displayName: "Restore Writer B",
  email: "restore-b@test.local",
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

describe("A10: Restore Flow Invariants", () => {
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
    setBroadcastRestoreInvalidation(null as any);
    destroyAllSessions();
    await ctx.cleanup();
  });

  // ── A10.1 ─────────────────────────────────────────────────────────

  it("A10.1: restore pre-commits all dirty state before replacing content", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a101" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const uniqueMarker = `A10.1 pre-commit ${Date.now()}`;

    // Dirty the session and register as contributor
    live.mutateSection(writerA.id, overviewKey, `## Overview\n\n${uniqueMarker}`);
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);
    expect(live.raw.fragments.dirtyKeys.size).toBeGreaterThan(0);

    const headBefore = await getHeadSha(ctx.rootDir);

    // Pre-commit (as restore would)
    const preCommitResult = await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);
    expect(preCommitResult).not.toBeNull();
    expect(preCommitResult!.committedSha).toBeTruthy();
    expect(preCommitResult!.committedSha).not.toBe(headBefore);

    // The dirty content should now be in canonical
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    expect(String(sections.get("Overview") ?? "")).toContain(uniqueMarker);
  });

  // ── A10.2 ─────────────────────────────────────────────────────────

  it("A10.2: restore pre-commit captures affectedWriters from perUserDirty BEFORE normalization", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a102-a" },
    });

    // Add second writer
    await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerB.id, identity: writerB, socketId: "sock-a102-b" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    // Writer A edits Overview
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nWriter A's pre-commit edit.");
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);

    // Writer B edits Timeline
    live.mutateSection(writerB.id, timelineKey, "## Timeline\n\nWriter B's pre-commit edit.");
    addContributor(SAMPLE_DOC_PATH, writerB.id, writerB);

    // Pre-commit captures affected writers
    const preCommitResult = await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);
    expect(preCommitResult).not.toBeNull();

    // Both writers should be listed as affected
    const writerIds = preCommitResult!.affectedWriters.map((w) => w.writerId);
    expect(writerIds).toContain(writerA.id);
    expect(writerIds).toContain(writerB.id);

    // Writer A should have Overview heading path
    const writerAEntry = preCommitResult!.affectedWriters.find((w) => w.writerId === writerA.id);
    expect(writerAEntry).toBeDefined();
    const writerAHeadings = writerAEntry!.dirtyHeadingPaths.map((hp) => hp.join(">>"));
    expect(writerAHeadings).toContain("Overview");

    // Writer B should have Timeline heading path
    const writerBEntry = preCommitResult!.affectedWriters.find((w) => w.writerId === writerB.id);
    expect(writerBEntry).toBeDefined();
    const writerBHeadings = writerBEntry!.dirtyHeadingPaths.map((hp) => hp.join(">>"));
    expect(writerBHeadings).toContain("Timeline");
  });

  // ── A10.3 ─────────────────────────────────────────────────────────

  it("A10.3: restore destroys session overlay, raw fragment files, and Y.Doc", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a103" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Dirty the session to create overlay files
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nA10.3 session invalidation.");
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);

    // Pre-commit (creates overlay files, then commits and cleans up)
    const preCommitResult = await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);

    // Invalidate session
    await invalidateSessionForRestore(
      SAMPLE_DOC_PATH,
      "abc1234",
      "Test Admin",
      preCommitResult,
    );

    // Session should be destroyed
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    // Raw fragments should be gone (cleanup happened in pre-commit)
    const rawFragments = await listRawFragments(SAMPLE_DOC_PATH);
    expect(rawFragments.length).toBe(0);
  });

  // ── A10.4 ─────────────────────────────────────────────────────────

  it("A10.4: after restore, new session acquisition loads purely from restored canonical", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a104" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Dirty the session
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nPre-restore dirty content.");
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);

    // Pre-commit + invalidate
    const preCommitResult = await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);
    await invalidateSessionForRestore(SAMPLE_DOC_PATH, "abc1234", "Test Admin", preCommitResult);

    // Get the current head (after pre-commit)
    const postRestoreHead = await getHeadSha(ctx.rootDir);

    // Acquire a new session — should load from canonical (not stale overlay)
    const newLive = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead: postRestoreHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a104-new" },
    });

    // Content should be from canonical (the pre-committed content)
    const newOverviewKey = findHeadingKey(newLive, "Overview");
    const content = newLive.raw.fragments.readFullContent(newOverviewKey);
    expect(String(content)).toContain("Pre-restore dirty content.");

    // No dirty keys in the fresh session
    expect(newLive.raw.fragments.dirtyKeys.size).toBe(0);
  });

  // ── A10.5 ─────────────────────────────────────────────────────────

  it("A10.5: restore broadcasts invalidation to connected clients", async () => {
    const broadcasts: string[] = [];
    setBroadcastRestoreInvalidation((docPath) => {
      broadcasts.push(docPath);
    });

    await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a105" },
    });

    // Invalidate (no pre-commit needed for this test)
    await invalidateSessionForRestore(SAMPLE_DOC_PATH, "abc1234", "Test Admin", null);

    // Broadcast should have been called with the doc path
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]).toBe(SAMPLE_DOC_PATH);

    // Session should be destroyed
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
  });
});
