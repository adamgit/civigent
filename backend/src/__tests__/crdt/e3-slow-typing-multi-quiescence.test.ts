/**
 * E3: BACKEND GUARD — multiple quiescence cycles never accumulate a duplicate
 * heading path in canonical.
 *
 * Scope note (why this is GREEN, not a reproduction): the snapshots/new3.md
 * mass-duplication is FRONTEND-driven. After the first quiescence splits a sibling
 * heading out, the REST-driven editor topology does not adopt the split, so the
 * survivor editor stays mounted and the author's continued keystrokes (heading text
 * included) land back in the WRONG fragment — which a later quiescence re-promotes,
 * duplicating it. That mis-routing happens in the browser and cannot be reproduced
 * by a backend-only harness (it is the subject of frontend tests E5/E6 once the
 * live-topology-adoption fix exists).
 *
 * What this test DOES guard is the backend half people assumed was the cause: given
 * a CORRECT second editing burst into the (already-split) survivor — body-only, no
 * re-typed heading, which is what the backend actually receives — two real
 * quiescence cycles through the production binary-frame path + off-lane editor ack
 * must NEVER accumulate a duplicate: the once-split `Second Section` stays a single
 * section. Confirms the backend does not self-duplicate via stale re-classification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  handleMessageForTest,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { encodeUpdate } from "../../ws/crdt-ws-frames.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readSection } from "../../storage/section-reader.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const EDITOR_SOCKET = "editor-sock-1";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

function buildClientUpdate(session: DocSession, key: string, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

/** Quiesce, then ack the off-lane pause and pump until the commit clears the proposal. */
async function quiesceAndCommit(session: DocSession, socketId: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
  // The off-lane publish establishes the pause one microtask after the quiescence
  // command returns; the split path lengthens that chain, so pump until it is up.
  for (let i = 0; i < 200 && !session.publishPause.isActive(); i++) {
    await vi.advanceTimersByTimeAsync(1);
    await session.enqueue(() => undefined);
  }
  expect(session.publishPause.isActive()).toBe(true);
  session.publishPause.markReady(socketId);
  for (let i = 0; i < 50 && session.generator.hasCurrentProposal(); i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  await session.enqueue(() => undefined);
  expect(session.generator.hasCurrentProposal()).toBe(false);
}

/** Distinct heading paths must never repeat in canonical. */
async function assertNoDuplicateHeadingPaths(): Promise<void> {
  const headingPaths = await CanonicalReader.open().listHeadingPaths(SAMPLE_DOC_PATH);
  const keys = headingPaths.map((p) => SectionRef.headingKey(p));
  expect(new Set(keys).size).toBe(keys.length);
  const secondSectionCount = keys.filter((k) => k === SectionRef.headingKey(["Second Section"])).length;
  expect(secondSectionCount).toBe(1);
}

describe("E3 (backend guard): slow-typing across multiple quiescence cycles", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("a second editing burst into the still-mounted survivor does not duplicate the once-split heading", async () => {
    vi.useFakeTimers();
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET);
    disposers.push(editor.dispose);

    // CYCLE 1: type a sibling heading → quiescence 1 splits + commits it.
    await handleMessageForTest(
      editor.socket,
      editor.state,
      Buffer.from(
        encodeUpdate(
          buildClientUpdate(
            session,
            OVERVIEW_KEY,
            "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
          ),
        ),
      ),
    );
    expect(session.generator.hasCurrentProposal()).toBe(true);
    await quiesceAndCommit(session, EDITOR_SOCKET);

    // After cycle 1: canonical has Overview (leaf) + Second Section exactly once.
    expect(await readSection(SAMPLE_DOC_PATH, ["Second Section"])).toContain("brand new sibling body");
    await assertNoDuplicateHeadingPaths();

    // CYCLE 2: the survivor is still mounted; keep typing into it (NO new heading).
    // The live Overview fragment is now the leaf "## Overview\n\nbase overview
    // body" — append more prose, simulating the slow-typing continuation.
    await handleMessageForTest(
      editor.socket,
      editor.state,
      Buffer.from(
        encodeUpdate(
          buildClientUpdate(
            session,
            OVERVIEW_KEY,
            "## Overview\n\nbase overview body\n\nslow typing continues into the survivor" as FragmentContent,
          ),
        ),
      ),
    );
    expect(session.generator.hasCurrentProposal()).toBe(true);
    await quiesceAndCommit(session, EDITOR_SOCKET);

    // After cycle 2: the continuation reached canonical, the survivor kept its
    // base body, and the once-split sibling did NOT duplicate (the new3.md bug).
    const overview = await readSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(overview).toContain("base overview body");
    expect(overview).toContain("slow typing continues into the survivor");
    expect(overview).not.toContain("## Second Section");
    expect(await readSection(SAMPLE_DOC_PATH, ["Second Section"])).toContain("brand new sibling body");
    await assertNoDuplicateHeadingPaths();
  });
});
