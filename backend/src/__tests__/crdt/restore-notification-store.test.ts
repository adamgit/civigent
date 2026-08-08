import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
  getReplacementNoticeForDisplacedSession,
  invalidateSessionForReplacement,
  setBroadcastSessionReplacementInvalidation,
} from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };

describe("getReplacementNoticeForDisplacedSession", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setBroadcastSessionReplacementInvalidation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    destroyAllSessions();
    await ctx.cleanup();
  });

  async function displaceLiveSession(message: string): Promise<string> {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
    const displacedId = session.liveYDocId;
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, { message });
    return displacedId;
  }

  it("stores nothing when invalidation finds no live session", async () => {
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, {
      message: "document was restored to an earlier version",
    });
    expect(getReplacementNoticeForDisplacedSession("doc-session-that-never-existed", SAMPLE_DOC_PATH)).toBeNull();
  });

  it("delivers the notice to a holder of the displaced session id", async () => {
    const displacedId = await displaceLiveSession("document was restored to an earlier version");

    const result = getReplacementNoticeForDisplacedSession(displacedId, SAMPLE_DOC_PATH);
    expect(result).not.toBeNull();
    expect(result!.message).toBe("document was restored to an earlier version");
  });

  it("returns null for an unrelated or absent previous session id", async () => {
    await displaceLiveSession("admin overwrote this document");

    expect(getReplacementNoticeForDisplacedSession("some-other-session-id", SAMPLE_DOC_PATH)).toBeNull();
    expect(getReplacementNoticeForDisplacedSession(null, SAMPLE_DOC_PATH)).toBeNull();
  });

  it("returns null when the displaced id is presented against a different document", async () => {
    const displacedId = await displaceLiveSession("admin overwrote this document");

    expect(getReplacementNoticeForDisplacedSession(displacedId, "/some/other-doc.md" as typeof SAMPLE_DOC_PATH)).toBeNull();
  });

  it("stores nothing when replacement carries no notice", async () => {
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
    const displacedId = session.liveYDocId;
    await invalidateSessionForReplacement(SAMPLE_DOC_PATH, null);

    expect(getReplacementNoticeForDisplacedSession(displacedId, SAMPLE_DOC_PATH)).toBeNull();
  });

  it("returns null after TTL expires", async () => {
    const displacedId = await displaceLiveSession("document was restored to an earlier version");

    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(getReplacementNoticeForDisplacedSession(displacedId, SAMPLE_DOC_PATH)).toBeNull();
  });

  it("does not consume the entry — every displaced client sees the same notice", async () => {
    const displacedId = await displaceLiveSession("admin overwrote this document");

    const resultA = getReplacementNoticeForDisplacedSession(displacedId, SAMPLE_DOC_PATH);
    const resultB = getReplacementNoticeForDisplacedSession(displacedId, SAMPLE_DOC_PATH);

    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    expect(resultA!.message).toBe("admin overwrote this document");
    expect(resultB!.message).toBe("admin overwrote this document");
  });
});
