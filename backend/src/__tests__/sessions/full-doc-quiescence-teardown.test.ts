import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import {
  destroyAllSessions,
  lookupDocSession,
  releaseDocSession,
  runSessionQuiescenceIdleTick,
} from "../../crdt/ydoc-lifecycle.js";

describe("full-doc quiescence teardown", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("does not tear down on last-editor-leaves alone, but tears down on full-doc quiescence and rebuilds fresh 1:1 on next acquire", async () => {
    const writer = {
      id: "quiescence-writer",
      type: "human" as const,
      displayName: "Quiescence Writer",
    };
    const session = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writer.id,
        identity: writer,
        socketId: "sock-quiescence-1",
      },
    });
    const originalSessionId = session.docSessionId;

    const releaseResult = await releaseDocSession(SAMPLE_DOC_PATH, writer.id, "sock-quiescence-1");
    expect(releaseResult.sessionEnded).toBe(false);
    expect(lookupDocSession(SAMPLE_DOC_PATH)?.docSessionId).toBe(originalSessionId);

    await runSessionQuiescenceIdleTick(session, session.lastActivityAt + 61_000);
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeUndefined();

    const rebuilt = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writer.id,
        identity: writer,
        socketId: "sock-quiescence-2",
      },
    });
    expect(rebuilt.docSessionId).not.toBe(originalSessionId);

    for (const headingPaths of rebuilt.headingPathByFragmentKey.values()) {
      expect(headingPaths.length).toBe(1);
    }
  });
});
