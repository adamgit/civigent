/**
 * Quiescence-time invariant: a registered live fragment must resolve to an
 * identity in the effective layout, otherwise it is a server-side registry vs.
 * layout drift bug. The CRDT live-edit acceptance gate at INGRESS is the normal
 * protection for client-touched untargetable fragments; quiescence is not a
 * discovery point for those.
 *
 * These tests directly invoke `normalizeQuiescedStructure()` through the
 * `normalizeQuiescedStructureForTest` helper so the throw is observable — the
 * runtime path uses `void enqueue(...)` from the quiescence timer, which would
 * void-swallow the rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  normalizeQuiescedStructureForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { buildFragmentContent, type FragmentContent, type SectionBody } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const PHANTOM_KEY = "section::phantom";

async function openSessionWithProposal(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
  // Coordinator-driven quiescence is only reachable after `hasCurrentProposal()`,
  // so seed the inprogress proposal with a benign accepted edit before the test
  // simulates the phantom-fragment condition.
  session.liveFragments.replaceFragmentString(
    OVERVIEW_KEY,
    buildFragmentContent("alice's local edit" as SectionBody, 2, "Overview"),
  );
  session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
  await session.generator.materializeEdit({ touchedFragmentKeys: [OVERVIEW_KEY] });
  return session;
}

describe("normalizeQuiescedStructure() — unresolved-fragment correctness gate", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    await ctx.cleanup();
  });

  it("throws when a registered fragment has content but no identity in the effective layout", async () => {
    const session = await openSessionWithProposal();

    // A phantom fragment key with real content that resolves to nothing in the
    // effective layout. Populating via `replaceFragmentString` also registers
    // the key, so the quiescence loop sees it in `getFragmentKeys()`.
    const dirty = "## Phantom\n\nsomething the client should never have been able to send" as FragmentContent;
    session.liveFragments.replaceFragmentString(PHANTOM_KEY, dirty);
    session.fragmentLastActivity.set(PHANTOM_KEY, Date.now());

    await expect(
      session.enqueue(() => normalizeQuiescedStructureForTest(session)),
    ).rejects.toThrow(/no identity in the effective layout/);
  });

  it("throws when a registered fragment has recorded activity even if content is empty", async () => {
    const session = await openSessionWithProposal();

    // Registered + empty content, but activity was recorded — that means a
    // client touched it. Ingress should have rejected an untargetable edit; if
    // we see it at quiescence, the acceptance gate missed a case.
    session.liveFragments.registerFragmentKey(PHANTOM_KEY);
    session.fragmentLastActivity.set(PHANTOM_KEY, Date.now());

    await expect(
      session.enqueue(() => normalizeQuiescedStructureForTest(session)),
    ).rejects.toThrow(/no identity in the effective layout/);
  });

  it("silently skips a registered fragment with no activity and empty content (stale bookkeeping)", async () => {
    const session = await openSessionWithProposal();

    // Registered but never edited — the only benign shape at quiescence.
    session.liveFragments.registerFragmentKey(PHANTOM_KEY);

    // Should not throw. `applied` is false because there is nothing structural
    // to reflect for the other canonical fragments (none of them were touched).
    await expect(
      session.enqueue(() => normalizeQuiescedStructureForTest(session)),
    ).resolves.toBe(false);
  });
});
