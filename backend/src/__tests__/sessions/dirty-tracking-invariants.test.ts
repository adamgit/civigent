/**
 * Group A2: Fragment Dirty Tracking & Attribution Invariant Tests
 *
 * Pre-refactor invariant tests for dirty tracking and per-user attribution.
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import {
  destroyAllSessions,
  markFragmentDirty,
  setSessionOverlayImportCallback,
  releaseDocSession,
  flushDirtyToOverlay,
  findKeyForHeadingPath,
} from "../../crdt/ydoc-lifecycle.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot, getSessionFragmentsRoot } from "../../storage/data-root.js";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { WriterIdentity } from "../../types/shared.js";

const writerA: WriterIdentity = {
  id: "dirty-track-writer-a",
  type: "human",
  displayName: "Writer A",
  email: "writer-a@test.local",
};

const writerB: WriterIdentity = {
  id: "dirty-track-writer-b",
  type: "human",
  displayName: "Writer B",
  email: "writer-b@test.local",
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

function appendParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

async function commitToCanonical(writers: WriterIdentity[], docPath: string) {
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const [primary] = writers;
  const commitMsg = `human edit: ${primary.displayName}\n\nWriter: ${primary.id}`;
  const author = { name: primary.displayName, email: primary.email ?? "human@knowledge-store.local" };
  return store.absorbChangedSections(getSessionSectionsContentRoot(), commitMsg, author, { docPaths: [docPath] });
}

describe("A2: Fragment Dirty Tracking & Attribution Invariants", () => {
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

  // ── A2.1 ──────────────────────────────────────────────────────────

  it("A2.1: applying a Yjs update marks exactly the touched fragment keys as dirty", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a21" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    // Build a remote doc from the session's Y.Doc state
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(live.ydoc));
    const svBefore = Y.encodeStateVector(remoteDoc);

    // Edit ONLY the Overview fragment
    remoteDoc.transact(() => {
      appendParagraph(remoteDoc.getXmlFragment(overviewKey), "A2.1 single-section edit.");
    });

    const payload = Y.encodeStateAsUpdate(remoteDoc, svBefore);
    const touchedKeys = live.liveFragments.applyClientUpdate(writerA.id, payload, undefined);
    for (const key of touchedKeys) {
      live.liveFragments.noteAheadOfStaged(key);
      markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, key);
    }

    // Overview should be dirty, Timeline should NOT
    expect(live.liveFragments.isAheadOfStaged(overviewKey)).toBe(true);
    expect(live.liveFragments.isAheadOfStaged(timelineKey)).toBe(false);
  });

  // ── A2.2 ──────────────────────────────────────────────────────────

  it("A2.2: perUserDirty correctly attributes fragment keys to the writer who changed them", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a22-a" },
    });

    // Add second writer
    await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerB.id, identity: writerB, socketId: "sock-a22-b" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    // Writer A edits Overview
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    // Writer B edits Timeline
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, timelineKey);

    // Check attribution
    const aDirty = live.perUserDirty.get(writerA.id);
    const bDirty = live.perUserDirty.get(writerB.id);

    expect(aDirty).toBeDefined();
    expect(bDirty).toBeDefined();
    expect(aDirty!.has(overviewKey)).toBe(true);
    expect(aDirty!.has(timelineKey)).toBe(false);
    expect(bDirty!.has(timelineKey)).toBe(true);
    expect(bDirty!.has(overviewKey)).toBe(false);
  });

  // ── A2.3 ──────────────────────────────────────────────────────────

  it("A2.3: fragment activity timestamps are updated on each edit", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a23" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // No activity timestamps initially
    expect(live.fragmentFirstActivity.has(overviewKey)).toBe(false);

    const beforeMark = Date.now();
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    const afterMark = Date.now();

    const firstActivity = live.fragmentFirstActivity.get(overviewKey);
    const lastActivity = live.fragmentLastActivity.get(overviewKey);

    expect(firstActivity).toBeDefined();
    expect(lastActivity).toBeDefined();
    expect(firstActivity!).toBeGreaterThanOrEqual(beforeMark);
    expect(firstActivity!).toBeLessThanOrEqual(afterMark);
    expect(lastActivity!).toBeGreaterThanOrEqual(beforeMark);

    // Second mark should update lastActivity but keep firstActivity
    const firstActivityBefore = firstActivity!;
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    expect(live.fragmentFirstActivity.get(overviewKey)).toBe(firstActivityBefore);
    expect(live.fragmentLastActivity.get(overviewKey)!).toBeGreaterThanOrEqual(lastActivity!);
  });

  // ── A2.4 ──────────────────────────────────────────────────────────

  it("A2.4: dirtyKeys is non-empty when fragments dirtied, empty after commit", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a24" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Initially not dirty
    expect(live.liveFragments.getAheadOfStagedKeys().size).toBe(0);

    // Mark dirty
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    live.liveFragments.noteAheadOfStaged(overviewKey);
    expect(live.liveFragments.getAheadOfStagedKeys().size).toBeGreaterThan(0);

    // Flush to disk
    await flushDirtyToOverlay(live);

    // After flush, dirtyKeys should be cleared
    expect(live.liveFragments.getAheadOfStagedKeys().size).toBe(0);

    // Commit to canonical
    const result = await commitToCanonical([writerA], SAMPLE_DOC_PATH);
    if (result.changedSections.length > 0) {
      await cleanupSessionOverlay(SAMPLE_DOC_PATH);
    }

    // After commit, still clean
    expect(live.liveFragments.getAheadOfStagedKeys().size).toBe(0);
  });
});
