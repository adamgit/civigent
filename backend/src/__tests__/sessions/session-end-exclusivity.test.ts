import { describe, it, expect, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  acquireDocSession,
  releaseDocSession,
  destroyAllSessions,
  awaitFinalization,
  __clearFinalizingDocsForTests,
} from "../../crdt/ydoc-lifecycle.js";
import type { WriterIdentity } from "../../types/shared.js";

const WRITER_A: WriterIdentity = { id: "writer-a", type: "human", displayName: "Writer A" };
const WRITER_B: WriterIdentity = { id: "writer-b", type: "human", displayName: "Writer B" };

describe("session-end exclusivity gate", () => {
  let ctx: TempDataRootContext;

  afterEach(async () => {
    destroyAllSessions();
    __clearFinalizingDocsForTests();
    if (ctx) await ctx.cleanup();
  });

  it("acquireDocSession during in-flight finalize waits until completeFinalization is called", async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    const baseHead = await getHeadSha(ctx.rootDir);

    // Acquire session A, release last editor — installs finalization gate.
    const sessionA = await acquireDocSession(
      SAMPLE_DOC_PATH, WRITER_A.id, baseHead, WRITER_A, "sock-a",
    );
    const sessionAId = sessionA.docSessionId;

    const releaseResult = await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    expect(releaseResult.sessionEnded).toBe(true);
    expect(releaseResult.completeFinalization).not.toBeNull();

    // Gate is installed — concurrent acquire must not progress until resolved.
    expect(awaitFinalization(SAMPLE_DOC_PATH)).toBeDefined();

    let acquireResolved = false;
    const acquirePromise = acquireDocSession(
      SAMPLE_DOC_PATH, WRITER_B.id, baseHead, WRITER_B, "sock-b",
    ).then((s) => {
      acquireResolved = true;
      return s;
    });

    // Let the microtask queue churn — the acquire should still be blocked.
    await new Promise((r) => setTimeout(r, 50));
    expect(acquireResolved).toBe(false);

    // Release the gate → acquire unblocks.
    releaseResult.completeFinalization!();

    const sessionB = await acquirePromise;
    expect(acquireResolved).toBe(true);
    // Freshly constructed session, not the same as session A.
    expect(sessionB.docSessionId).not.toBe(sessionAId);
    // Gate entry cleared after resolve.
    expect(awaitFinalization(SAMPLE_DOC_PATH)).toBeUndefined();
  });

  it("completeFinalization is non-null when sessionEnded is true and null otherwise", async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    const baseHead = await getHeadSha(ctx.rootDir);

    // No session → null resolver on early return.
    const emptyRelease = await releaseDocSession(SAMPLE_DOC_PATH, "nobody", "sock-nobody");
    expect(emptyRelease.sessionEnded).toBe(false);
    expect(emptyRelease.completeFinalization).toBeNull();

    // Two editors — releasing one does not end session.
    await acquireDocSession(SAMPLE_DOC_PATH, WRITER_A.id, baseHead, WRITER_A, "sock-a");
    await acquireDocSession(SAMPLE_DOC_PATH, WRITER_B.id, baseHead, WRITER_B, "sock-b");

    const nonLastRelease = await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    expect(nonLastRelease.sessionEnded).toBe(false);
    expect(nonLastRelease.completeFinalization).toBeNull();
    // Gate is NOT installed on non-last-editor release.
    expect(awaitFinalization(SAMPLE_DOC_PATH)).toBeUndefined();

    // Last editor release ends session and installs gate.
    const lastRelease = await releaseDocSession(SAMPLE_DOC_PATH, WRITER_B.id, "sock-b");
    expect(lastRelease.sessionEnded).toBe(true);
    expect(lastRelease.completeFinalization).not.toBeNull();
    lastRelease.completeFinalization!();
  });
});
