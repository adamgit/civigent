/**
 * Group A5: Publish Flow (End-to-End) Invariant Tests
 *
 * Pre-refactor invariant tests for publishUnpublishedSections (the "Publish Now" path).
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";

import { getHeadSha } from "../../storage/git-repo.js";
import { publishUnpublishedSections } from "../../storage/auto-commit.js";
import {
  destroyAllSessions,
  markFragmentDirty,
  setSessionOverlayImportCallback,
  flushDirtyToOverlay,
  findKeyForHeadingPath,
} from "../../crdt/ydoc-lifecycle.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity } from "../../types/shared.js";

const writerA: WriterIdentity = {
  id: "pub-writer-a",
  type: "human",
  displayName: "Pub Writer A",
  email: "pub-a@test.local",
};

const writerB: WriterIdentity = {
  id: "pub-writer-b",
  type: "human",
  displayName: "Pub Writer B",
  email: "pub-b@test.local",
};

function findHeadingKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
): string {
  const key = findKeyForHeadingPath(live, [heading]);
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

describe("A5: Publish Flow Invariants", () => {
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

  // ── A5.1 ──────────────────────────────────────────────────────────

  it("A5.1: publish commits only the publisher's dirty fragments, not other writers' sections", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a51-a" },
    });

    // Add writer B
    await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerB.id, identity: writerB, socketId: "sock-a51-b" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    // Writer A edits Overview
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nWriter A published this."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    // Writer B edits Timeline
    live.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("## Timeline\n\nWriter B unpublished edit."));
    live.liveFragments.noteAheadOfStaged(timelineKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, timelineKey);

    // Pre-flush both
    await flushDirtyToOverlay(live);
    // Re-mark perUserDirty since flush cleared it
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, timelineKey);

    // Capture canonical before publish
    const canonical = new ContentLayer(ctx.contentDir);
    const beforeSections = await canonical.readAllSections(SAMPLE_DOC_PATH);

    // Writer A publishes (scoped to Overview)
    const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(result.committed).toBe(true);

    // Canonical should have writer A's edit
    const afterSections = await canonical.readAllSections(SAMPLE_DOC_PATH);

    // Overview should have changed
    expect(afterSections.get("Overview")).not.toEqual(beforeSections.get("Overview"));
    expect(String(afterSections.get("Overview"))).toContain("Writer A published this.");

    // Writer B's dirty state should still be intact
    expect(live.perUserDirty.get(writerB.id)?.has(timelineKey)).toBe(true);
  });

  // ── A5.2 ──────────────────────────────────────────────────────────

  it("A5.2: publish normalizes matched keys before committing", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a52" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Inject content with an embedded heading (structurally dirty)
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nOriginal overview.\n\n## Injected Section\n\nInjected content."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    // Publish — should normalize (split) before committing
    const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    // After publish, canonical should contain both headings properly split
    const canonical = new ContentLayer(ctx.contentDir);
    const afterSections = await canonical.readAllSections(SAMPLE_DOC_PATH);

    // "Injected Section" should exist as a separate section in canonical
    expect(afterSections.has("Injected Section")).toBe(true);
    expect(String(afterSections.get("Injected Section"))).toContain("Injected content.");
    expect(String(afterSections.get("Overview"))).toContain("Original overview.");
  });

  // ── A5.3 ──────────────────────────────────────────────────────────

  it("A5.3: after publish, committed sections are no longer dirty for the publishing writer", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a53" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit and verify dirty
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nPublished overview content."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    expect(live.perUserDirty.get(writerA.id)?.has(overviewKey)).toBe(true);

    // Publish
    const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    // After publish, writer A's dirty state for this key should be cleared
    expect(live.perUserDirty.get(writerA.id)?.has(overviewKey)).toBe(false);
  });

  // ── A5.4 ──────────────────────────────────────────────────────────

  it("A5.4: publish returns per-doc commit details with the sections that actually changed", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a54" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit Overview only
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nA5.4 event test content."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    expect(result.docCommits).toHaveLength(1);
    const docCommit = result.docCommits[0];
    expect(docCommit.docPath).toBe(SAMPLE_DOC_PATH);
    expect(docCommit.sectionsPublished.length).toBeGreaterThan(0);

    // The committed sections should include Overview
    const committedHeadings = docCommit.sectionsPublished.map(
      (s: { heading_path: string[] }) => s.heading_path,
    );
    const hasOverview = committedHeadings.some(
      (hp: string[]) => hp.length === 1 && hp[0] === "Overview",
    );
    expect(hasOverview).toBe(true);

    // Timeline should NOT be in the committed sections (it wasn't edited)
    const hasTimeline = committedHeadings.some(
      (hp: string[]) => hp.length === 1 && hp[0] === "Timeline",
    );
    expect(hasTimeline).toBe(false);
  });

  // ── A5.5 ──────────────────────────────────────────────────────────

  it("A5.5: publish returns the cleared heading paths for the publishing writer", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a55" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit Overview
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nA5.5 dirty:changed test."));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    expect(result.docCommits).toHaveLength(1);
    const clearedHeadingPaths = result.docCommits[0].publisherClearedHeadingPaths;
    expect(clearedHeadingPaths.length).toBeGreaterThan(0);

    // The cleared-heading-path set should reference Overview's heading path
    const overviewDirtyEvent = clearedHeadingPaths.find(
      (headingPath) => headingPath.length === 1 && headingPath[0] === "Overview",
    );
    expect(overviewDirtyEvent).toBeDefined();
  });

  // ── A5.6 ──────────────────────────────────────────────────────────

  it("A5.6: published content is readable from canonical git after commit", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a56" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    const uniqueMarker = `A5.6 canonical verification ${Date.now()}`;
    live.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark(`## Overview\n\n${uniqueMarker}`));
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);
    expect(result.commitSha).toBeTruthy();

    // Read from canonical — the committed content should be there
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    const overviewContent = String(sections.get("Overview") ?? "");
    expect(overviewContent).toContain(uniqueMarker);

    // Verify the git HEAD advanced
    const newHead = await getHeadSha(ctx.rootDir);
    expect(newHead).toBe(result.commitSha);
  });

  // ── A5.7 ──────────────────────────────────────────────────────────

  it("A5.7: stale losing settle passes must not contribute fragment cleanup", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a57" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    const overviewBefore = live.liveFragments.readFragmentString(overviewKey);
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark(`${overviewBefore}\n\nA5.7 publish content.`),
    );
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    const timelineRawBefore = live.liveFragments.readFragmentString(timelineKey);
    await live.recoveryBuffer.writeFragment(timelineKey, timelineRawBefore);
    expect(await live.liveFragments.readPersistedFragment(timelineKey)).toEqual(timelineRawBefore);

    const originalSettle = live.liveFragments.settleFragment.bind(live.liveFragments);
    let settleCalls = 0;
    live.liveFragments.settleFragment = async (...args) => {
      settleCalls += 1;
      if (settleCalls === 1) {
        return {
          acceptedKeys: new Set<string>(),
          structuralChange: null,
          remaps: [],
          updatedIndex: null,
          writtenKeys: [overviewKey],
          deletedKeys: [timelineKey],
          staleOverlay: true,
        };
      }
      return {
        acceptedKeys: new Set<string>([overviewKey]),
        structuralChange: null,
        remaps: [],
        updatedIndex: null,
        writtenKeys: [overviewKey],
        deletedKeys: [],
        staleOverlay: false,
      };
    };

    try {
      const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
      expect(result.committed).toBe(true);
      expect(settleCalls).toBe(2);

      // Losing stale passes must NOT leak deletedKeys into final cleanup.
      const timelineRawAfter = await live.liveFragments.readPersistedFragment(timelineKey);
      expect(timelineRawAfter).toEqual(timelineRawBefore);
    } finally {
      live.liveFragments.settleFragment = originalSettle;
    }
  });

  // ── A5.8 ──────────────────────────────────────────────────────────

  it("A5.8: edits arriving during the publish commit window must remain dirty and durably buffered", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a58" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const before = live.liveFragments.readFragmentString(overviewKey);
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark(`${before}\n\nA5.8 publish baseline edit.`),
    );
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);

    const lateMarker = `A5.8 late edit ${Date.now()}`;
    const originalAbsorb = CanonicalStore.prototype.absorbChangedSections;
    let injectedLateEdit = false;
    CanonicalStore.prototype.absorbChangedSections = async function (...args) {
      if (!injectedLateEdit) {
        injectedLateEdit = true;
        const latest = live.liveFragments.readFragmentString(overviewKey);
        live.liveFragments.replaceFragmentString(
          overviewKey,
          fragmentFromRemark(`${latest}\n\n${lateMarker}`),
        );
        live.liveFragments.noteAheadOfStaged(overviewKey);
        markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
        await live.liveFragments.snapshotToRecovery(new Set([overviewKey]));
      }
      return await originalAbsorb.apply(this, args);
    };

    try {
      const result = await publishUnpublishedSections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
      expect(result.committed).toBe(true);

      const canonical = new ContentLayer(ctx.contentDir);
      const afterSections = await canonical.readAllSections(SAMPLE_DOC_PATH);
      expect(String(afterSections.get("Overview") ?? "")).not.toContain(lateMarker);

      // A post-snapshot live edit must remain unpublished but still dirty.
      expect(live.perUserDirty.get(writerA.id)?.has(overviewKey)).toBe(true);

      // And it must still be crash-durable in the raw fragment sidecar.
      const persistedRaw = await live.liveFragments.readPersistedFragment(overviewKey);
      expect(String(persistedRaw ?? "")).toContain(lateMarker);
    } finally {
      CanonicalStore.prototype.absorbChangedSections = originalAbsorb;
    }
  });
});
