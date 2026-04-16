/**
 * Empty-document session bootstrap: acquiring a session for a doc whose
 * skeleton roots are empty must seed the synthetic BFH fragment key into
 * every in-memory index BEFORE LiveFragmentStringsStore is constructed,
 * then populate the Y.Doc with an empty BFH fragment under
 * SERVER_INJECTION_ORIGIN so it is not marked ahead-of-staged.
 *
 * Invariant: session orderedFragmentKeys, headingPath index,
 * live-store getFragmentKeys, and Y.Doc contents all agree on the single
 * BFH key from the first editor sync onward.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { acquireDocSession, destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { SectionRef } from "../../domain/section-ref.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "human-test-user",
  type: "human",
  displayName: "Empty Doc Test Writer",
  email: "empty@test.local",
};

describe("acquireDocSession empty-doc BFH bootstrap", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("empty doc: session indexes + live-store + Y.Doc all agree on a single BFH key", async () => {
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit", "--allow-empty", "-m", "seed",
      ],
      ctx.rootDir,
    );
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession("/brand/new.md", writer.id, baseHead, writer, "sock-empty");

    expect(session.orderedFragmentKeys).toEqual([BEFORE_FIRST_HEADING_KEY]);
    expect(session.headingPathByFragmentKey.get(BEFORE_FIRST_HEADING_KEY)).toEqual([]);
    expect(session.fragmentKeyByHeadingPathKey.get(SectionRef.headingKey([]))).toBe(BEFORE_FIRST_HEADING_KEY);

    expect(session.liveFragments.getFragmentKeys()).toEqual([BEFORE_FIRST_HEADING_KEY]);
    expect(session.liveFragments.hasFragmentKey(BEFORE_FIRST_HEADING_KEY)).toBe(true);

    // Y.Doc has the fragment (reading does not throw; content returns a string/object)
    const content = session.liveFragments.readFragmentString(BEFORE_FIRST_HEADING_KEY);
    expect(content).toBeDefined();

    // Server injection must not mark the bootstrap content as ahead-of-staged
    expect(session.liveFragments.getAheadOfStagedKeys().has(BEFORE_FIRST_HEADING_KEY)).toBe(false);
  });

  it("non-empty doc: BFH synthetic key is NOT injected alongside real sections", async () => {
    await createSampleDocument(ctx.rootDir);
    const baseHead = await getHeadSha(ctx.rootDir);
    const session = await acquireDocSession(SAMPLE_DOC_PATH, writer.id, baseHead, writer, "sock-sample");

    const keys = session.liveFragments.getFragmentKeys();
    const headingPaths = Array.from(session.headingPathByFragmentKey.values());

    expect(keys.length).toBeGreaterThan(1);

    // The sample doc DOES have a BFH section (preamble), but it comes from the
    // real skeleton, not the synthetic bootstrap branch. The test's job is to
    // confirm that when real sections exist, acquire does NOT take the
    // empty-doc fast path (which would produce a 1-key session).
    expect(keys.length).toBe(headingPaths.length);
    for (const key of keys) {
      expect(session.headingPathByFragmentKey.has(key)).toBe(true);
    }
    for (const key of session.headingPathByFragmentKey.keys()) {
      expect(keys).toContain(key);
    }
  });
});
