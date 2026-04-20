/**
 * Normalization coalescer: `requestNormalization` batches multiple calls in
 * the same microtask into one `acceptLiveFragments` call scoped to the union
 * of requested keys. A second batch after the first drain must be a separate
 * call (no stale accumulation).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  acquireDocSession,
  destroyAllSessions,
  requestNormalization,
} from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "human-test-user",
  type: "human",
  displayName: "Coalescer Test Writer",
  email: "coalescer@test.local",
};

describe("requestNormalization — per-docPath coalescer", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("three rapid requests for different keys produce one acceptLiveFragments call with all keys", async () => {
    await createSampleDocument(ctx.rootDir);
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-coalesce-1",
    );

    // Capture calls to acceptLiveFragments.
    const calls: Array<ReadonlySet<string> | "all"> = [];
    const originalAccept = session.stagedSections.acceptLiveFragments.bind(
      session.stagedSections,
    );
    session.stagedSections.acceptLiveFragments = ((liveStore, scope) => {
      calls.push(scope);
      return originalAccept(liveStore, scope);
    }) as typeof session.stagedSections.acceptLiveFragments;

    const keys = session.liveFragments.getFragmentKeys();
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const [k1, k2, k3] = keys;

    // Mark each key ahead-of-staged so the coalescer has work to do.
    session.liveFragments.noteAheadOfStaged(k1);
    session.liveFragments.noteAheadOfStaged(k2);
    session.liveFragments.noteAheadOfStaged(k3);

    // Fire three requests in the same microtask.
    const p1 = requestNormalization(SAMPLE_DOC_PATH, k1);
    const p2 = requestNormalization(SAMPLE_DOC_PATH, k2);
    const p3 = requestNormalization(SAMPLE_DOC_PATH, k3);

    await Promise.all([p1, p2, p3]);

    expect(calls.length).toBe(1);
    const scope = calls[0];
    expect(scope).not.toBe("all");
    const scopeSet = scope as ReadonlySet<string>;
    expect(scopeSet.has(k1)).toBe(true);
    expect(scopeSet.has(k2)).toBe(true);
    expect(scopeSet.has(k3)).toBe(true);
  });

  it("a second batch after the first drains is a separate acceptLiveFragments call", async () => {
    await createSampleDocument(ctx.rootDir);
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writer.id,
      baseHead,
      writer,
      "sock-coalesce-2",
    );

    const calls: Array<ReadonlySet<string> | "all"> = [];
    const originalAccept = session.stagedSections.acceptLiveFragments.bind(
      session.stagedSections,
    );
    session.stagedSections.acceptLiveFragments = ((liveStore, scope) => {
      calls.push(scope);
      return originalAccept(liveStore, scope);
    }) as typeof session.stagedSections.acceptLiveFragments;

    const keys = session.liveFragments.getFragmentKeys();
    const [k1, k2] = keys;

    session.liveFragments.noteAheadOfStaged(k1);
    await requestNormalization(SAMPLE_DOC_PATH, k1);

    session.liveFragments.noteAheadOfStaged(k2);
    await requestNormalization(SAMPLE_DOC_PATH, k2);

    expect(calls.length).toBe(2);
    const first = calls[0] as ReadonlySet<string>;
    const second = calls[1] as ReadonlySet<string>;
    expect(first.has(k1)).toBe(true);
    expect(first.has(k2)).toBe(false);
    expect(second.has(k2)).toBe(true);
    expect(second.has(k1)).toBe(false);
  });
});
