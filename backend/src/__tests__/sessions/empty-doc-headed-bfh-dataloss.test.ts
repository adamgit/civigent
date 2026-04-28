/**
 * Regression test for the "dataloss on refresh after typing headings into an
 * empty document" bug. Reproduction:
 *   1. Create an empty document.
 *   2. Open a CRDT session (acquireDocSession seeds a synthetic BFH fragment).
 *   3. Inject `# A\n\nbody A\n\n# B\n\nbody B\n` into the BFH fragment.
 *   4. Close the session cleanly — accept + absorb + cleanup must run.
 *
 * Pre-fix behaviour: `acceptLiveFragments`'s BFH bootstrap branch asserted
 * that the post-upsert skeleton must contain a BFH entry. When the live BFH
 * content began with a heading, the upsert correctly emitted only headed
 * sections and no BFH — the assertion threw, session-end finalization
 * aborted, and the user's typed sections were lost.
 *
 * Post-fix behaviour: accept completes, absorb commits, re-acquire shows
 * the two headed sections on disk.
 *
 * Note: this is the Side-A-adapted port of the original 5e14e6c regression
 * test. The broadcast-capture assertion (`setNormalizeBroadcast`) was
 * dropped because Side A removed the normalize-broadcast surface; the unit-
 * level BFH→headed remap shape is covered by
 * `accept-live-fragments-bfh-bootstrap.test.ts`. This test still exercises
 * the full session-end → absorb → re-acquire path that the original bug
 * broke.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  acquireDocSession,
  releaseDocSession,
  destroyAllSessions,
  markFragmentDirty,
  settleFragmentKeysFromLive,
} from "../../crdt/ydoc-lifecycle.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { getContentRoot, getDataRoot, getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { WriterIdentity } from "../../types/shared.js";

const DOC_PATH = "/workspace/fresh-empty.md";

const writer: WriterIdentity = {
  id: "empty-doc-writer",
  type: "human",
  displayName: "Empty Doc Writer",
  email: "empty@test.local",
};

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe("empty doc — typing headings into BFH commits without dataloss (regression)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    // Seed a base commit so HEAD exists for acquireDocSession.
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "--allow-empty", "-m", "seed"],
      ctx.rootDir,
    );
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("accept + absorb + cleanup run to completion; re-acquire sees headed sections", async () => {
    // (a) Create empty document + commit it to canonical.
    const canonical = new OverlayContentLayer(getContentRoot(), getContentRoot());
    await canonical.createDocument(DOC_PATH);
    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit",
        "-m", "create empty doc",
        "--trailer", "Writer-Type: human",
      ],
      ctx.rootDir,
    );
    const baseHead = await getHeadSha(ctx.rootDir);

    // (b) Acquire session — synthetic BFH is seeded into the live Y.Doc.
    const session = await acquireDocSession(DOC_PATH, writer.id, baseHead, writer, "sock-empty-1");
    expect(session.liveFragments.getFragmentKeys()).toEqual([BEFORE_FIRST_HEADING_KEY]);

    // (c) Inject `# A\n\nbody A\n\n# B\n\nbody B\n` into the BFH fragment.
    // `origin === undefined` is the non-server path, so afterTransaction
    // marks the BFH key ahead-of-staged exactly like a real client edit.
    session.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      fragmentFromRemark("# A\n\nbody A\n\n# B\n\nbody B\n"),
      undefined,
    );
    // The afterTransaction listener marks BFH ahead-of-staged because origin
    // was not SERVER_INJECTION_ORIGIN. The per-user dirty tracking is a
    // separate concern driven by the WS applyClientUpdate path in production;
    // replicate it directly here.
    markFragmentDirty(DOC_PATH, writer.id, BEFORE_FIRST_HEADING_KEY);
    expect(session.liveFragments.getAheadOfStagedKeys().has(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    // (d) Force a settle on the dirty BFH key. This is the path that hit
    // the BFH-bootstrap assertion in the pre-fix code; post-fix it completes
    // successfully. Side A's release-driven quiescence is timing-bound, so
    // we exercise the settle directly instead of relying on idle teardown.
    const headBeforeAbsorb = await getHeadSha(ctx.rootDir);
    await settleFragmentKeysFromLive(session, [BEFORE_FIRST_HEADING_KEY]);

    await releaseDocSession(DOC_PATH, writer.id, "sock-empty-1");

    // (e) Manually run the absorb + cleanup steps that the ws coordinator
    // normally performs after releaseDocSession. This is the production path:
    // see backend/src/ws/crdt-coordinator.ts::absorbStagedAndRemoveSessionFiles.
    const canonicalStore = new CanonicalStore(getContentRoot(), getDataRoot());
    const absorbResult = await canonicalStore.absorbChangedSections(
      getSessionSectionsContentRoot(),
      `human edit: ${writer.displayName}\n\nWriter: ${writer.id}\nWriter-Type: ${writer.type}`,
      { name: writer.displayName, email: writer.email! },
      { documentPathsToRewrite: [DOC_PATH] },
    );

    // HEAD advanced by one commit.
    const headAfterAbsorb = await getHeadSha(ctx.rootDir);
    expect(headAfterAbsorb).not.toBe(headBeforeAbsorb);
    expect(absorbResult.commitSha).toBe(headAfterAbsorb);

    // Remove session overlay files (cleanup step).
    const overlayRoot = getSessionSectionsContentRoot();
    const normalized = DOC_PATH.replace(/\\/g, "/").replace(/^\/+/, "");
    const skeletonPath = path.resolve(overlayRoot, ...normalized.split("/"));
    await rm(skeletonPath, { force: true });
    await rm(`${skeletonPath}.sections`, { recursive: true, force: true });
    await new RawFragmentRecoveryBuffer(DOC_PATH)._resetForDocPath();

    // No session overlay files remain.
    expect(await exists(skeletonPath)).toBe(false);
    expect(await exists(`${skeletonPath}.sections`)).toBe(false);

    // Force-destroy any lingering session so the next acquire rebuilds from
    // canonical rather than reusing the in-memory session that release left
    // alive (Side A's release is a no-op when quiescence isn't met).
    destroyAllSessions();

    // Fresh acquire sees two headed sections with the expected bodies.
    const freshSession = await acquireDocSession(
      DOC_PATH,
      writer.id,
      headAfterAbsorb,
      writer,
      "sock-empty-2",
    );
    // liveFragments key set contains the two new headed keys and NOT BFH.
    const freshKeys = freshSession.liveFragments.getFragmentKeys();
    expect(freshKeys.length).toBe(2);
    expect(freshKeys).not.toContain(BEFORE_FIRST_HEADING_KEY);

    // Heading-path identity is now owned by the storage layer (the session-level
    // index was removed in Side A). Read the canonical skeleton to verify A and B
    // exist as the only top-level sections.
    const postAbsorb = new OverlayContentLayer(getContentRoot(), getContentRoot());
    const sections = await postAbsorb.getSectionList(DOC_PATH);
    expect(sections.map((s) => s.headingPath)).toEqual([["A"], ["B"]]);

    // Body content round-trips on disk.
    const bodyA = await postAbsorb.readSection(new SectionRef(DOC_PATH, ["A"]));
    const bodyB = await postAbsorb.readSection(new SectionRef(DOC_PATH, ["B"]));
    expect(bodyA).toContain("body A");
    expect(bodyB).toContain("body B");
  });
});
