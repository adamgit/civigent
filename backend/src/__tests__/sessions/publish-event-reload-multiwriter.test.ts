import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { commitDirtySections, setAutoCommitEventHandler } from "../../storage/auto-commit.js";
import {
  acquireDocSession,
  destroyAllSessions,
  setSessionOverlayImportCallback,
} from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay } from "../../storage/session-store.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity, WsServerEvent } from "../../types/shared.js";

const writerA: WriterIdentity = {
  id: "writer-a",
  type: "human",
  displayName: "Writer A",
  email: "writer-a@test.local",
};

const writerB: WriterIdentity = {
  id: "writer-b",
  type: "human",
  displayName: "Writer B",
  email: "writer-b@test.local",
};

function toHeadingKey(headingPath: string[]): string {
  return headingPath.join(">>");
}

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
  if (!key) {
    throw new Error(`Missing fragment key for heading "${heading}"`);
  }
  return key;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function changedSectionKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
  const allKeys = new Set<string>([...before.keys(), ...after.keys()]);
  return new Set(
    [...allKeys].filter((key) => {
      return (before.get(key) ?? null) !== (after.get(key) ?? null);
    }),
  );
}

function keysFromSectionTargets(
  sections: Array<{ doc_path: string; heading_path: string[] }>,
): Set<string> {
  return new Set(sections.map((section) => toHeadingKey(section.heading_path)));
}

function keysFromContentCommittedEvents(events: WsServerEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type !== "content:committed") continue;
    for (const section of event.sections) {
      keys.add(toHeadingKey(section.heading_path));
    }
  }
  return keys;
}

function keysFromDirtyClearedEvents(events: WsServerEvent[], writerId: string): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.type !== "dirty:changed") continue;
    if (event.writer_id !== writerId) continue;
    if (event.dirty !== false) continue;
    keys.add(toHeadingKey(event.heading_path));
  }
  return keys;
}

async function openLiveSession(
  rootDir: string,
  writer: WriterIdentity,
  socketId: string,
): Promise<Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>> {
  const baseHead = await getHeadSha(rootDir);
  return documentSessionRegistry.getOrCreate({
    docPath: SAMPLE_DOC_PATH,
    baseHead,
    initialEditor: {
      writerId: writer.id,
      identity: writer,
      socketId,
    },
  });
}

describe("publish event contract, cross-reload invariants, and multi-writer scoped behavior", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
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

  it("publish event contract should match actual canonical diff for scoped publish", async () => {
    const live = await openLiveSession(ctx.rootDir, writerA, "sock-event-contract");
    const overviewKey = findHeadingKey(live, "Overview");
    const before = live.raw.fragments.readFullContent(overviewKey);
    const mutateResult = live.mutateSection(
      writerA.id,
      overviewKey,
      `${before}\n\nOverview edit for publish event contract.`,
    );
    expect(mutateResult.error).toBeUndefined();

    const canonical = new ContentLayer(ctx.contentDir);
    const beforeSections = await canonical.readAllSections(SAMPLE_DOC_PATH);

    const events: WsServerEvent[] = [];
    setAutoCommitEventHandler((event) => events.push(event));

    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(result.committed).toBe(true);

    const afterSections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    const actualChangedKeys = changedSectionKeys(beforeSections, afterSections);
    const publishedKeys = keysFromSectionTargets(result.sectionsPublished);
    const committedEventKeys = keysFromContentCommittedEvents(events);
    const dirtyClearedKeys = keysFromDirtyClearedEvents(events, writerA.id);

    expect(publishedKeys).toEqual(actualChangedKeys);
    expect(committedEventKeys).toEqual(actualChangedKeys);
    expect(dirtyClearedKeys).toEqual(actualChangedKeys);
  });

  it("cross-reload invariants: after scoped publish and reconnect, no duplicate headings or orphan body bleed", async () => {
    const live = await openLiveSession(ctx.rootDir, writerA, "sock-reload-before");
    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    const overviewBefore = live.raw.fragments.readFullContent(overviewKey);
    const mutateResult = live.mutateSection(
      writerA.id,
      overviewKey,
      `${overviewBefore}\n\nOverview edit before scoped publish and reconnect.`,
    );
    expect(mutateResult.error).toBeUndefined();

    // Transient malformed state in untouched Timeline.
    live.raw.fragments.setFragmentContent(
      timelineKey,
      fragmentFromRemark("Timeline malformed body-only content that should never persist."),
    );

    const publishResult = await commitDirtySections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);

    // Simulate teardown + reconnect.
    destroyAllSessions();
    const reopened = await openLiveSession(ctx.rootDir, writerA, "sock-reload-after");

    const canonical = new ContentLayer(ctx.contentDir);
    const canonicalAssembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);
    const reopenedAssembled = reopened.raw.fragments.assembleMarkdown();

    for (const assembled of [canonicalAssembled, reopenedAssembled]) {
      expect(countOccurrences(assembled, "## Overview")).toBe(1);
      expect(countOccurrences(assembled, "## Timeline")).toBe(1);
      expect(assembled).not.toContain("Timeline malformed body-only content that should never persist.");
      expect(assembled).toContain(SAMPLE_SECTIONS.timeline);
    }
  });

  it("multi-writer scoped publish should not collateral-delete untouched malformed section and should not clear other writer dirty state", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writerA.id,
        identity: writerA,
        socketId: "sock-writer-a",
      },
    });

    await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerB.id,
      baseHead,
      writerB,
      "sock-writer-b",
    );

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    const overviewBefore = live.raw.fragments.readFullContent(overviewKey);
    const writerAEdit = live.mutateSection(
      writerA.id,
      overviewKey,
      `${overviewBefore}\n\nWriter A scoped publish edit.`,
    );
    expect(writerAEdit.error).toBeUndefined();

    // Writer B has a dirty malformed Timeline, but Writer A publishes only Overview.
    const writerBEdit = live.mutateSection(
      writerB.id,
      timelineKey,
      "Writer B malformed body-only timeline content.",
    );
    expect(writerBEdit.error).toBeUndefined();
    expect(live.raw.perUserDirty.get(writerB.id)?.has(timelineKey)).toBe(true);

    const events: WsServerEvent[] = [];
    setAutoCommitEventHandler((event) => events.push(event));

    const publishResult = await commitDirtySections(writerA, SAMPLE_DOC_PATH, [["Overview"]]);
    expect(publishResult.committed).toBe(true);

    const canonical = new ContentLayer(ctx.contentDir);
    const assembled = await canonical.readAssembledDocument(SAMPLE_DOC_PATH);
    expect(assembled).toContain("## Timeline");
    expect(assembled).toContain(SAMPLE_SECTIONS.timeline);
    expect(assembled).not.toContain("Writer B malformed body-only timeline content.");

    // Writer B's unrelated dirty state should not be cleared by Writer A's scoped publish.
    expect(live.raw.perUserDirty.get(writerB.id)?.has(timelineKey)).toBe(true);
    const writerBDirtyClearedKeys = keysFromDirtyClearedEvents(events, writerB.id);
    expect(writerBDirtyClearedKeys.has("Timeline")).toBe(false);
  });
});
