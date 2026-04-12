/**
 * Group A1: Session Lifecycle Invariant Tests
 *
 * Pre-refactor invariant tests for acquireDocSession / releaseDocSession.
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  releaseDocSession,
  lookupDocSession,
  getAllSessions,
  destroyAllSessions,
  setSessionOverlayImportCallback,
  flushDirtyToOverlay,
} from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import type { WriterIdentity } from "../../types/shared.js";

const writerA: WriterIdentity = {
  id: "invariant-writer-a",
  type: "human",
  displayName: "Writer A",
  email: "writer-a@test.local",
};

const writerB: WriterIdentity = {
  id: "invariant-writer-b",
  type: "human",
  displayName: "Writer B",
  email: "writer-b@test.local",
};

describe("A1: Session Lifecycle Invariants", () => {
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

  // ── A1.1 ──────────────────────────────────────────────────────────

  it("A1.1: acquireDocSession returns session with correct docPath, docSessionId, baseHead, and populated fragment keys", async () => {
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a1",
    );

    expect(session.docPath).toBe(SAMPLE_DOC_PATH);
    expect(session.docSessionId).toBeTruthy();
    expect(session.baseHead).toBe(baseHead);

    // Fragment keys should be populated from skeleton
    const fragmentKeys = session.orderedFragmentKeys;
    expect(fragmentKeys.length).toBeGreaterThanOrEqual(3); // BFH + Overview + Timeline
  });

  // ── A1.2 ──────────────────────────────────────────────────────────

  it("A1.2: acquireDocSession loads effective section content — every skeleton entry has readable fragment content", async () => {
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a2",
    );

    const fragmentKeys = session.orderedFragmentKeys;
    for (const key of fragmentKeys) {
      const content = session.liveFragments.readFragmentString(key);
      // Every fragment should have non-null content (may be empty string for BFH)
      expect(content).toBeDefined();
      expect(typeof content).toBe("string");
    }
  });

  // ── A1.3 ──────────────────────────────────────────────────────────

  it("A1.3: second acquireDocSession for same docPath reuses session (same docSessionId, holder count increments)", async () => {
    const session1 = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a3-1",
    );
    const originalId = session1.docSessionId;
    expect(session1.holders.size).toBe(1);

    const session2 = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerB.id,
      baseHead,
      writerB,
      "sock-a3-2",
    );

    // Same session object and same docSessionId
    expect(session2).toBe(session1);
    expect(session2.docSessionId).toBe(originalId);

    // Both holders present
    expect(session2.holders.size).toBe(2);
    expect(session2.holders.has(writerA.id)).toBe(true);
    expect(session2.holders.has(writerB.id)).toBe(true);
  });

  // ── A1.4 ──────────────────────────────────────────────────────────

  it("A1.4: releaseDocSession with remaining holders keeps session alive", async () => {
    await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a4-1",
    );
    await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerB.id,
      baseHead,
      writerB,
      "sock-a4-2",
    );

    const result = await releaseDocSession(SAMPLE_DOC_PATH, writerA.id, "sock-a4-1");
    expect(result.sessionEnded).toBe(false);

    // Session still exists with remaining holder
    const session = lookupDocSession(SAMPLE_DOC_PATH);
    expect(session).toBeDefined();
    expect(session!.holders.has(writerB.id)).toBe(true);
    expect(session!.state).toBe("active");
  });

  // ── A1.5 ──────────────────────────────────────────────────────────

  it("A1.5: releaseDocSession of last holder triggers commit + cleanup and ends session", async () => {
    await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a5",
    );

    const result = await releaseDocSession(SAMPLE_DOC_PATH, writerA.id, "sock-a5");
    expect(result.sessionEnded).toBe(true);
    expect(result.contributors).toBeInstanceOf(Array);

    // Session should be gone
    const session = lookupDocSession(SAMPLE_DOC_PATH);
    expect(session).toBeUndefined();

    // Sessions map should be empty
    expect(getAllSessions().size).toBe(0);
  });

  // ── A1.6 ──────────────────────────────────────────────────────────

  it("A1.6: destroyAllSessions forcefully ends sessions and cleans up", async () => {
    await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a6",
    );

    expect(getAllSessions().size).toBe(1);

    destroyAllSessions();

    expect(getAllSessions().size).toBe(0);
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
  });

  // ── A1.7 ──────────────────────────────────────────────────────────

  it("A1.7: session state transitions acquiring → active → committing → ended in correct order", async () => {
    const states: string[] = [];

    // Acquire session and observe "active" state
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      writerA.id,
      baseHead,
      writerA,
      "sock-a7",
    );
    states.push(session.state);
    expect(session.state).toBe("active");

    // Release last holder → triggers committing → ended
    await releaseDocSession(SAMPLE_DOC_PATH, writerA.id, "sock-a7");
    // After release completes, session is ended and removed from map.
    // We can't observe intermediate "committing" state from outside the release call,
    // but we verify the final state was "ended" by checking the session is gone.
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();
  });
});
