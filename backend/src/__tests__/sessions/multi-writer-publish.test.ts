import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  releaseDocSession,
  markFragmentDirty,
  setSessionOverlayImportCallback,
  destroyAllSessions,
  flushDirtyToOverlay,
} from "../../crdt/ydoc-lifecycle.js";

import { commitDirtySections, setAutoCommitEventHandler } from "../../storage/auto-commit.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import type { WriterIdentity, WsServerEvent } from "../../types/shared.js";

describe("multi-writer publish does not touch co-editors' dirty state (Bug D)", () => {
  let ctx: TempDataRootContext;

  const writerA: WriterIdentity = { id: "writer-a", type: "human", displayName: "Writer A", email: "a@test.local" };
  const writerB: WriterIdentity = { id: "writer-b", type: "human", displayName: "Writer B", email: "b@test.local" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });
  });

  afterAll(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("publishing writer A leaves writer B's dirty state intact on shared sections", async () => {
    const baseHead = await getHeadSha(ctx.rootDir);

    // Both writers acquire the session
    const session = await acquireDocSession(SAMPLE_DOC_PATH, writerA.id, baseHead, writerA);
    await acquireDocSession(SAMPLE_DOC_PATH, writerB.id, baseHead, writerB);

    // Find the fragment key for "Overview" section
    let overviewKey: string | null = null;
    for (const [key, hp] of session.headingPathByFragmentKey) {
      if (hp[hp.length - 1] === "Overview") {
        overviewKey = key;
        break;
      }
    }
    expect(overviewKey).not.toBeNull();

    // Both writers dirty the same section. We mutate the actual fragment
    // content so the canonical-diff in canonical absorb produces
    // a real changed-section list (Bug C narrowing requires real content
    // change to register a publish — marking dirty without mutation no
    // longer counts).
    const overviewBefore = session.liveFragments.readFragmentString(overviewKey!);
    session.liveFragments.replaceFragmentString(
      overviewKey!,
      fragmentFromRemark(`${overviewBefore}\n\nShared edit by writer A and writer B.`),
    );
    session.liveFragments.noteAheadOfStaged(overviewKey!);
    markFragmentDirty(SAMPLE_DOC_PATH, writerA.id, overviewKey!);
    markFragmentDirty(SAMPLE_DOC_PATH, writerB.id, overviewKey!);
    // Pre-flush to write overlay files (simulates debounced flush in production)
    await flushDirtyToOverlay(session);
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

    // Writer A's dirty state for the published section is cleared.
    expect(session.perUserDirty.get(writerA.id)?.has(overviewKey!)).toBe(false);

    // Bug D: Writer B's dirty state must NOT be touched by Writer A's publish,
    // even when both writers dirtied the same fragment. Writer B's local view
    // remains "dirty until B publishes their own state" — A's publish does not
    // implicitly speak for B.
    expect(session.perUserDirty.get(writerB.id)?.has(overviewKey!)).toBe(true);

    // Bug D: dirty:changed events must NOT be emitted for writer B as a side
    // effect of writer A's publish.
    const writerBDirtyEvents = events.filter(
      (e) => e.type === "dirty:changed" && (e as any).writer_id === writerB.id,
    );
    expect(writerBDirtyEvents.length).toBe(0);

    // Clean up
    await releaseDocSession(SAMPLE_DOC_PATH, writerA.id);
    await releaseDocSession(SAMPLE_DOC_PATH, writerB.id);
  });
});
