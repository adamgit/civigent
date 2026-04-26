import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { setSystemReady } from "../../startup-state.js";
import { issueTokenPair } from "../../auth/tokens.js";
import { installDefaultSessionOverlayImportCallback } from "../../ws/crdt-coordinator.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import {
  addContributor,
  destroyAllSessions,
  findKeyForHeadingPath,
  invalidateSessionForReplacement,
  markFragmentDirty,
  setSessionOverlayImportCallback,
  triggerImmediateSessionOverlayImport,
} from "../../crdt/ydoc-lifecycle.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createHumanCommit,
  createSampleDocument,
  SAMPLE_DOC_PATH,
} from "../helpers/sample-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import type { WriterIdentity } from "../../types/shared.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("restore race regressions", () => {
  let ctx: TempDataRootContext;
  let app: ReturnType<typeof createApp>;
  let writer: WriterIdentity;
  let writerToken: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSystemReady();
    app = createApp();
    writer = {
      id: "restore-race-writer",
      type: "human",
      displayName: "Restore Race Writer",
      email: "restore-race@test.local",
    };
    writerToken = issueTokenPair({
      id: writer.id,
      type: writer.type,
      displayName: writer.displayName,
    }).access_token;
  });

  afterEach(async () => {
    installDefaultSessionOverlayImportCallback();
    destroyAllSessions();
    await ctx.cleanup();
  });

  async function createDirtySession(baseHead: string) {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: {
        writerId: writer.id,
        identity: writer,
        socketId: `sock-${Date.now()}`,
      },
    });
    const overviewKey = findKeyForHeadingPath(live, ["Overview"]);
    if (!overviewKey) {
      throw new Error("Missing Overview fragment key");
    }
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nDirty live content that should not race restore."),
    );
    live.liveFragments.noteAheadOfStaged(overviewKey);
    markFragmentDirty(SAMPLE_DOC_PATH, writer.id, overviewKey);
    addContributor(SAMPLE_DOC_PATH, writer.id, writer);
    return { live, overviewKey };
  }

  it("restore route should wait for an in-flight overlay import before mutating canonical history", async () => {
    const restoreTargetSha = await getHeadSha(ctx.rootDir);
    await createHumanCommit(
      ctx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Newer canonical content before restore.\n",
      0,
    );
    const currentHead = await getHeadSha(ctx.rootDir);
    await createDirtySession(currentHead);

    let releaseImport: (() => void) | null = null;
    const importStarted = new Promise<void>((resolve) => {
      setSessionOverlayImportCallback(async (session) => {
        resolve();
        await new Promise<void>((resume) => {
          releaseImport = resume;
        });
        await session.recoveryBuffer.snapshotFromLive(session.liveFragments, "all");
      });
    });

    triggerImmediateSessionOverlayImport(SAMPLE_DOC_PATH);
    await importStarted;

    const restorePromise = new Promise<{ status: number }>((resolve, reject) => {
      request(app)
        .post(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/restore`)
        .set("Authorization", `Bearer ${writerToken}`)
        .send({ sha: restoreTargetSha })
        .end((err, res) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({ status: res.status });
        });
    });

    const resolvedBeforeImportFinished = await Promise.race([
      restorePromise.then(() => true),
      sleep(100).then(() => false),
    ]);
    expect(resolvedBeforeImportFinished).toBe(false);

    const headWhileImportIsBlocked = await getHeadSha(ctx.rootDir);
    expect(headWhileImportIsBlocked).toBe(currentHead);

    if (!releaseImport) {
      throw new Error("Expected blocked import release handle");
    }
    releaseImport();
    const response = await restorePromise;
    expect(response.status).toBe(200);
  });

  it("invalidateSessionForReplacement should not resolve until an in-flight overlay import finishes", async () => {
    const currentHead = await getHeadSha(ctx.rootDir);
    await createDirtySession(currentHead);

    let releaseImport: (() => void) | null = null;
    const importStarted = new Promise<void>((resolve) => {
      setSessionOverlayImportCallback(async (session) => {
        resolve();
        await new Promise<void>((resume) => {
          releaseImport = resume;
        });
        await session.recoveryBuffer.snapshotFromLive(session.liveFragments, "all");
      });
    });

    triggerImmediateSessionOverlayImport(SAMPLE_DOC_PATH);
    await importStarted;

    const invalidatePromise = invalidateSessionForReplacement(SAMPLE_DOC_PATH, null);

    const resolvedBeforeImportFinished = await Promise.race([
      invalidatePromise.then(() => true),
      sleep(100).then(() => false),
    ]);
    expect(resolvedBeforeImportFinished).toBe(false);

    if (!releaseImport) {
      throw new Error("Expected blocked import release handle");
    }
    releaseImport();
    await invalidatePromise;
  });
});
