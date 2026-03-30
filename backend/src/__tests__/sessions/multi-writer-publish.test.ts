import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  releaseDocSession,
  markFragmentDirty,
  setFlushCallback,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { commitDirtySections, setAutoCommitEventHandler } from "../../storage/auto-commit.js";
import { flushDocSessionToDisk } from "../../storage/session-store.js";
import { getHeadSha } from "../../storage/git-repo.js";
import type { WriterIdentity, WsServerEvent } from "../../types/shared.js";

describe("multi-writer publish clears co-editors' dirty state", () => {
  let ctx: TempDataRootContext;

  const writerA: WriterIdentity = { id: "writer-a", type: "human", displayName: "Writer A", email: "a@test.local" };
  const writerB: WriterIdentity = { id: "writer-b", type: "human", displayName: "Writer B", email: "b@test.local" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setFlushCallback(async (session) => {
      await flushDocSessionToDisk(session);
    });
  });

  afterAll(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("publishing writer A clears writer B's dirty state on shared sections", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);

    // Both writers acquire the session
    const session = await acquireDocSession(SAMPLE_DOC_PATH, writerA.id, baseHead, writerA);
    await acquireDocSession(SAMPLE_DOC_PATH, writerB.id, baseHead, writerB);

    // Find the fragment key for "Overview" section
    let overviewKey: string | null = null;
    session.fragments.skeleton.forEachSection((heading, level, sectionFile) => {
      if (heading === "Overview") {
        const isBfh = level === 0 && heading === "";
        overviewKey = fragmentKeyFromSectionFile(sectionFile, isBfh);
      }
    });
    expect(overviewKey).not.toBeNull();

    // Both writers dirty the same section
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey!);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, overviewKey!);
    // Mark fragment dirty so flush writes it to session overlay (simulates Y.Doc update)
    session.fragments.markDirty(overviewKey!);
    // Pre-flush to write overlay files (simulates debounced flush in production)
    await flushDocSessionToDisk(session);
    // Re-mark perUserDirty since flush cleared it
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey!);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, overviewKey!);

    // Verify both writers have dirty state
    expect(session.perUserDirty.get(writerA.id)?.has(overviewKey!)).toBe(true);
    expect(session.perUserDirty.get(writerB.id)?.has(overviewKey!)).toBe(true);

    // Collect emitted events
    const events: WsServerEvent[] = [];
    setAutoCommitEventHandler((event) => events.push(event));

    // Writer A publishes
    const result = await commitDirtySections(writerA, SAMPLE_DOC_PATH);
    expect(result.committed).toBe(true);

    // Writer B's dirty state for the committed section should be cleared
    const writerBDirty = session.perUserDirty.get(writerB.id);
    expect(writerBDirty?.has(overviewKey!)).toBe(false);

    // Dirty:changed events should have been emitted for writer B
    const writerBDirtyEvents = events.filter(
      (e) => e.type === "dirty:changed" && (e as any).writer_id === writerB.id,
    );
    expect(writerBDirtyEvents.length).toBeGreaterThan(0);

    // Clean up
    await releaseDocSession(SAMPLE_DOC_PATH, writerA.id);
    await releaseDocSession(SAMPLE_DOC_PATH, writerB.id);
  });
});
