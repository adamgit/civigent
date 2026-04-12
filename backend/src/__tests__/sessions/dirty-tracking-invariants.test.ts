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
} from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay, commitSessionFilesToCanonical, cleanupSessionFiles } from "../../storage/session-store.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
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

function appendParagraph(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

describe("A2: Fragment Dirty Tracking & Attribution Invariants", () => {
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
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(live.raw.fragments.ydoc));
    const svBefore = Y.encodeStateVector(remoteDoc);

    // Edit ONLY the Overview fragment
    remoteDoc.transact(() => {
      appendParagraph(remoteDoc.getXmlFragment(overviewKey), "A2.1 single-section edit.");
    });

    const payload = Y.encodeStateAsUpdate(remoteDoc, svBefore);
    const result = live.applyYjsUpdate(writerA.id, payload);
    expect(result.error).toBeUndefined();

    // Overview should be dirty, Timeline should NOT
    expect(live.raw.fragments.dirtyKeys.has(overviewKey)).toBe(true);
    expect(live.raw.fragments.dirtyKeys.has(timelineKey)).toBe(false);
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
    const aDirty = live.raw.perUserDirty.get(writerA.id);
    const bDirty = live.raw.perUserDirty.get(writerB.id);

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
    expect(live.raw.fragmentFirstActivity.has(overviewKey)).toBe(false);

    const beforeMark = Date.now();
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    const afterMark = Date.now();

    const firstActivity = live.raw.fragmentFirstActivity.get(overviewKey);
    const lastActivity = live.raw.fragmentLastActivity.get(overviewKey);

    expect(firstActivity).toBeDefined();
    expect(lastActivity).toBeDefined();
    expect(firstActivity!).toBeGreaterThanOrEqual(beforeMark);
    expect(firstActivity!).toBeLessThanOrEqual(afterMark);
    expect(lastActivity!).toBeGreaterThanOrEqual(beforeMark);

    // Second mark should update lastActivity but keep firstActivity
    const firstActivityBefore = firstActivity!;
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    expect(live.raw.fragmentFirstActivity.get(overviewKey)).toBe(firstActivityBefore);
    expect(live.raw.fragmentLastActivity.get(overviewKey)!).toBeGreaterThanOrEqual(lastActivity!);
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
    expect(live.raw.fragments.dirtyKeys.size).toBe(0);

    // Mark dirty
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    live.raw.fragments.markDirty(overviewKey);
    expect(live.raw.fragments.dirtyKeys.size).toBeGreaterThan(0);

    // Flush to disk
    await importSessionDirtyFragmentsToOverlay(live.raw);

    // After flush, dirtyKeys should be cleared
    expect(live.raw.fragments.dirtyKeys.size).toBe(0);

    // Commit to canonical
    const result = await commitSessionFilesToCanonical([writerA], SAMPLE_DOC_PATH);
    if (result.sectionsCommitted > 0) {
      await cleanupSessionFiles(SAMPLE_DOC_PATH);
    }

    // After commit, still clean
    expect(live.raw.fragments.dirtyKeys.size).toBe(0);
  });
});
