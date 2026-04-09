import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { commitDirtySections } from "../../storage/auto-commit.js";
import { destroyAllSessions, setSessionOverlayImportCallback } from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay } from "../../storage/session-store.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "key-selection-writer",
  type: "human",
  displayName: "Key Selection Writer",
  email: "key-selection@test.local",
};

function keySet(values: string[]): Set<string> {
  return new Set(values);
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
    throw new Error(`Missing key for heading "${heading}"`);
  }
  return key;
}

async function openSession(
  rootDir: string,
): Promise<Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>> {
  const baseHead = await getHeadSha(rootDir);
  return documentSessionRegistry.getOrCreate({
    docPath: SAMPLE_DOC_PATH,
    baseHead,
    initialEditor: {
      writerId: writer.id,
      identity: writer,
      socketId: "sock-key-selection",
    },
  });
}

async function appendEdit(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
  line: string,
): Promise<void> {
  const key = findHeadingKey(live, heading);
  const before = live.raw.fragments.readFullContent(key);
  const result = live.mutateSection(writer.id, key, `${before}\n\n${line}`);
  expect(result.error).toBeUndefined();
}

describe("auto-commit scoped normalization key selection", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await importSessionDirtyFragmentsToOverlay(session);
    });
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("heading-scoped publish should normalize exactly one targeted fragment key", async () => {
    const live = await openSession(ctx.rootDir);
    await appendEdit(live, "Overview", "Overview edit for single-target scope.");
    await appendEdit(live, "Timeline", "Timeline edit that should not be normalized in overview scope.");

    const normalizedKeys: string[] = [];
    const fragmentsAny = live.raw.fragments as any;
    const originalNormalize = fragmentsAny.normalizeStructure.bind(live.raw.fragments);
    fragmentsAny.normalizeStructure = async (fragmentKey: string, opts?: unknown) => {
      normalizedKeys.push(fragmentKey);
      return originalNormalize(fragmentKey, opts);
    };

    try {
      const result = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"]]);
      expect(result.committed).toBe(true);
    } finally {
      fragmentsAny.normalizeStructure = originalNormalize;
    }

    const overviewKey = findHeadingKey(live, "Overview");
    expect(keySet(normalizedKeys)).toEqual(keySet([overviewKey]));
  });

  it("multi-heading scope should normalize exactly the targeted fragment keys", async () => {
    const live = await openSession(ctx.rootDir);
    await appendEdit(live, "Overview", "Overview edit for multi-target scope.");
    await appendEdit(live, "Timeline", "Timeline edit for multi-target scope.");

    const normalizedKeys: string[] = [];
    const fragmentsAny = live.raw.fragments as any;
    const originalNormalize = fragmentsAny.normalizeStructure.bind(live.raw.fragments);
    fragmentsAny.normalizeStructure = async (fragmentKey: string, opts?: unknown) => {
      normalizedKeys.push(fragmentKey);
      return originalNormalize(fragmentKey, opts);
    };

    try {
      const result = await commitDirtySections(writer, SAMPLE_DOC_PATH, [["Overview"], ["Timeline"]]);
      expect(result.committed).toBe(true);
    } finally {
      fragmentsAny.normalizeStructure = originalNormalize;
    }

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");
    expect(keySet(normalizedKeys)).toEqual(keySet([overviewKey, timelineKey]));
  });

  it("unscoped publish should normalize only the writer's dirty fragment keys", async () => {
    // Per Bug A spec: even an unscoped publish (no headingPaths) must scope
    // normalization to this writer's dirty keys. The previous "normalize
    // everything" behavior was a bug — it touched untouched sections and could
    // corrupt sibling content via collateral merges.
    const live = await openSession(ctx.rootDir);
    await appendEdit(live, "Overview", "Overview edit for unscoped publish.");

    const normalizedKeys: string[] = [];
    const fragmentsAny = live.raw.fragments as any;
    const originalNormalize = fragmentsAny.normalizeStructure.bind(live.raw.fragments);
    fragmentsAny.normalizeStructure = async (fragmentKey: string, opts?: unknown) => {
      normalizedKeys.push(fragmentKey);
      return originalNormalize(fragmentKey, opts);
    };

    try {
      const result = await commitDirtySections(writer, SAMPLE_DOC_PATH);
      expect(result.committed).toBe(true);
    } finally {
      fragmentsAny.normalizeStructure = originalNormalize;
    }

    const overviewKey = findHeadingKey(live, "Overview");
    expect(keySet(normalizedKeys)).toEqual(keySet([overviewKey]));
  });
});
