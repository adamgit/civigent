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

import { getHeadSha } from "../../storage/git-repo.js";
import type { PreemptiveCommitResult } from "../../storage/auto-commit.js";
import {
  destroyAllSessions,
  setSessionOverlayImportCallback,
  lookupDocSession,
  invalidateSessionForReplacement,
  setBroadcastSessionReplacementInvalidation,
  addContributor,
  markFragmentDirty,
  applyAcceptResult,
  findKeyForHeadingPath,
  collectTouchedFragmentKeysForNormalization,
  flushDirtyToOverlay,
} from "../../crdt/ydoc-lifecycle.js";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity } from "../../types/shared.js";
import { readdir, rm } from "node:fs/promises";
import path, { join } from "node:path";

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
  const key = findKeyForHeadingPath(live, [heading]);
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

async function cleanupSessionOverlay(docPath: string): Promise<void> {
  const overlayRoot = getSessionSectionsContentRoot();
  const skelPath = path.join(overlayRoot, ...docPath.split("/"));
  await rm(skelPath, { force: true });
  await rm(`${skelPath}.sections`, { recursive: true, force: true });
  const fragDir = path.join(getSessionFragmentsRoot(), docPath);
  await rm(fragDir, { recursive: true, force: true });
}

async function commitToCanonical(writers: WriterIdentity[], docPath: string) {
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const [primary] = writers;
  const commitMsg = `human edit: ${primary.displayName}\n\nWriter: ${primary.id}`;
  const author = { name: primary.displayName, email: primary.email ?? "human@knowledge-store.local" };
  return store.absorbChangedSections(getSessionSectionsContentRoot(), commitMsg, author, { docPaths: [docPath] });
}

/** Test helper: inline store boundary pre-commit (mirrors route-level logic from BNATIVE.8c). */
async function preemptiveImportNormalizeAndCommit(
  docPath: string,
): Promise<PreemptiveCommitResult | null> {
  const session = lookupDocSession(docPath);
  if (!session) return null;
  let hasDirty = false;
  for (const dirtySet of session.perUserDirty.values()) {
    if (dirtySet.size > 0) { hasDirty = true; break; }
  }
  if (!hasDirty) return null;

  const affectedWriters: Array<{ writerId: string }> = [];
  for (const [writerId, dirtySet] of session.perUserDirty) {
    if (dirtySet.size === 0) continue;
    affectedWriters.push({ writerId });
  }

  const dirtySnapshot = collectTouchedFragmentKeysForNormalization(session);
  for (const key of dirtySnapshot) {
    session.liveFragments.noteAheadOfStaged(key);
  }
  await session.recoveryBuffer.snapshotFromLive(session.liveFragments, dirtySnapshot);
  const acceptResult = await session.stagedSections.acceptLiveFragments(session.liveFragments, dirtySnapshot);
  await applyAcceptResult(session, acceptResult);

  const result = await commitToCanonical(
    Array.from(session.contributors.values()),
    docPath,
  );
  if (!result.commitSha) {
    throw new Error(`Pre-commit for "${docPath}" produced no result`);
  }

  await cleanupSessionOverlay(docPath);
  return { committedSha: result.commitSha, affectedWriters };
}

describe("A10: Restore Flow Invariants", () => {
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
    setBroadcastSessionReplacementInvalidation(null as any);
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark(`## Overview\n\n${uniqueMarker}`));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);
    expect(live.liveFragments.getAheadOfStagedKeys().size).toBeGreaterThan(0);

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

  it("A10.2: restore pre-commit captures affected writers from perUserDirty BEFORE normalization", async () => {
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nWriter A's pre-commit edit."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);

    // Writer B edits Timeline
    live.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("## Timeline\n\nWriter B's pre-commit edit."));
    live.liveFragments.noteAheadOfStaged(timelineKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, timelineKey);
    addContributor(SAMPLE_DOC_PATH, writerB.id, writerB);

    // Pre-commit captures affected writers
    const preCommitResult = await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);
    expect(preCommitResult).not.toBeNull();

    // Both writers should be listed as affected
    const writerIds = preCommitResult!.affectedWriters.map((w) => w.writerId);
    expect(writerIds).toContain(writerA.id);
    expect(writerIds).toContain(writerB.id);

    expect(preCommitResult!.affectedWriters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ writerId: writerA.id }),
        expect.objectContaining({ writerId: writerB.id }),
      ]),
    );
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nA10.3 session invalidation."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);

    // Pre-commit (creates overlay files, then commits and cleans up)
    await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);

    // Invalidate session
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, null);

    // Session should be destroyed
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    // Raw fragments should be gone (cleanup happened in pre-commit)
    const rawFragments = await new RawFragmentRecoveryBuffer(SAMPLE_DOC_PATH).listFragmentKeys();
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
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nPre-restore dirty content."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    addContributor(SAMPLE_DOC_PATH, writerA.id, writerA);

    // Pre-commit + invalidate
    await preemptiveImportNormalizeAndCommit(SAMPLE_DOC_PATH);
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, null);

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
    const content = newLive.liveFragments.readFragmentString(newOverviewKey);
    expect(String(content)).toContain("Pre-restore dirty content.");

    // No dirty keys in the fresh session
    expect(newLive.liveFragments.getAheadOfStagedKeys().size).toBe(0);
  });

  // ── A10.5 ─────────────────────────────────────────────────────────

  it("A10.5: restore broadcasts invalidation to connected clients", async () => {
    const broadcasts: string[] = [];
    setBroadcastSessionReplacementInvalidation((docPath) => {
      broadcasts.push(docPath);
    });

    await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a105" },
    });

    // Invalidate (no pre-commit needed for this test)
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, null);

    // Broadcast should have been called with the doc path
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]).toBe(SAMPLE_DOC_PATH);

    // Session should be destroyed
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
  });
});
