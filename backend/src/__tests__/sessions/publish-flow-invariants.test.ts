/**
 * Group A5: Publish Flow (End-to-End) Invariant Tests
 *
 * Pre-refactor invariant tests for commitDirtySections (the "Publish Now" path).
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { commitDirtySections, setAutoCommitEventHandler } from "../../storage/auto-commit.js";
import {
  destroyAllSessions,
  markFragmentDirty,
  setSessionOverlayImportCallback,
} from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay } from "../../storage/session-store.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity, WsServerEvent } from "../../types/shared.js";

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

describe("A5: Publish Flow Invariants", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await importSessionDirtyFragmentsToOverlay(session);
    });
    setAutoCommitEventHandler(() => {});
  });

  afterEach(async () => {
    setAutoCommitEventHandler(() => {});
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
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nWriter A published this.");

    // Writer B edits Timeline
    live.mutateSection(writerB.id, timelineKey, "## Timeline\n\nWriter B unpublished edit.");

    // Pre-flush both
    await importSessionDirtyFragmentsToOverlay(live.raw);
    // Re-mark perUserDirty since flush cleared it
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, timelineKey);

    // Capture canonical before publish
    const canonical = new ContentLayer(ctx.contentDir);
    const beforeSections = await canonical.readAllSections(SAMPLE_DOC_PATH);

    // Writer A publishes (scoped to Overview)
    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(result.committed).toBe(true);

    // Canonical should have writer A's edit
    const afterSections = await canonical.readAllSections(SAMPLE_DOC_PATH);

    // Overview should have changed
    expect(afterSections.get("Overview")).not.toEqual(beforeSections.get("Overview"));
    expect(String(afterSections.get("Overview"))).toContain("Writer A published this.");

    // Writer B's dirty state should still be intact
    expect(live.raw.perUserDirty.get(writerB.id)?.has(timelineKey)).toBe(true);
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
    live.mutateSection(
      writerA.id,
      overviewKey,
      "## Overview\n\nOriginal overview.\n\n## Injected Section\n\nInjected content.",
    );

    // Publish — should normalize (split) before committing
    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH);
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
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nPublished overview content.");
    expect(live.raw.perUserDirty.get(writerA.id)?.has(overviewKey)).toBe(true);

    // Publish
    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    // After publish, writer A's dirty state for this key should be cleared
    expect(live.raw.perUserDirty.get(writerA.id)?.has(overviewKey)).toBe(false);
  });

  // ── A5.4 ──────────────────────────────────────────────────────────

  it("A5.4: publish emits content:committed event with the sections that actually changed", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a54" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit Overview only
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nA5.4 event test content.");

    const events: WsServerEvent[] = [];
    setAutoCommitEventHandler((event) => events.push(event));

    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    // Should have emitted content:committed
    const commitEvents = events.filter((e) => e.type === "content:committed");
    expect(commitEvents.length).toBe(1);

    const commitEvent = commitEvents[0];
    expect(commitEvent.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(commitEvent.sections.length).toBeGreaterThan(0);

    // The committed sections should include Overview
    const committedHeadings = commitEvent.sections.map(
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

  it("A5.5: publish emits dirty:changed events for cleared sections", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writerA.id, identity: writerA, socketId: "sock-a55" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Edit Overview
    live.mutateSection(writerA.id, overviewKey, "## Overview\n\nA5.5 dirty:changed test.");

    const events: WsServerEvent[] = [];
    setAutoCommitEventHandler((event) => events.push(event));

    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    // Should have emitted dirty:changed for the publishing writer
    const dirtyEvents = events.filter(
      (e) => e.type === "dirty:changed" && e.writer_id === writerA.id && e.dirty === false,
    );
    expect(dirtyEvents.length).toBeGreaterThan(0);

    // The dirty:changed event should reference Overview's heading path
    const overviewDirtyEvent = dirtyEvents.find(
      (e) => e.heading_path.length === 1 && e.heading_path[0] === "Overview",
    );
    expect(overviewDirtyEvent).toBeDefined();
    expect(overviewDirtyEvent!.committed_head).toBeTruthy();
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
    live.mutateSection(writerA.id, overviewKey, `## Overview\n\n${uniqueMarker}`);

    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH);
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
});
