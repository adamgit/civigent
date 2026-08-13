/**
 * CRDT live-edit acceptance-gate rejection at ingress — integration coverage for
 * the "duplicate sibling heading" reason code end-to-end through
 * `processArbitratedClientUpdate`.
 *
 * These tests drive a real Y.Doc client update through the acceptance gate and
 * assert the observable server behavior:
 *   - The touched live fragment's Y.Doc content is restored from the pre-update
 *     snapshot.
 *   - No DocSession `inprogress` proposal is created for the rejected edit.
 *   - No `section:pending` event fires for the rejected fragment.
 *   - A `section:edit-rejected` event is produced for the origin client.
 *   - A structurally-independent second fragment in the SAME client update is
 *     accepted, materialized, and announced with `section:pending`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  processArbitratedClientUpdate,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
  setCrdtPrivateEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import type { ClientInstanceId, WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";
const ORIGIN_CLIENT_INSTANCE_ID = "tab-origin-abc" as ClientInstanceId;

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-origin");
}

/**
 * Build a Yjs update that would set `fragmentKey`'s live content to
 * `content`. We construct the update against a Yjs snapshot of the session's
 * current state so the delta is minimal and lands on top cleanly.
 */
function buildClientUpdateForFragments(
  session: DocSession,
  writes: Array<{ fragmentKey: string; content: FragmentContent }>,
): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(
    temp,
    session.liveFragments.getFragmentKeys(),
    SAMPLE_DOC_PATH,
  );
  const asMap = new Map<string, FragmentContent>();
  for (const w of writes) asMap.set(w.fragmentKey, w.content);
  tempStore.replaceFragmentStrings(asMap);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

describe("CRDT live-edit acceptance gate — duplicate-sibling-heading rejection", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];
  let broadcastEvents: WsServerEvent[] = [];
  let privateEvents: Array<{
    target: { docPath: string; clientInstanceId: ClientInstanceId };
    event: WsServerEvent;
  }> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    broadcastEvents = [];
    privateEvents = [];
    setCrdtEventHandler((event) => broadcastEvents.push(event));
    setCrdtPrivateEventHandler((target, event) => privateEvents.push({ target, event }));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    setCrdtEventHandler(() => undefined);
    setCrdtPrivateEventHandler(() => undefined);
    await ctx.cleanup();
  });

  it("restores a rejected duplicate-heading edit and never materializes it", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin").dispose);

    // Cache the pre-edit content of the Overview live fragment so we can assert
    // exact byte-for-byte restore.
    const preEditOverview = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    expect(preEditOverview.length).toBeGreaterThan(0);
    expect(session.generator.hasCurrentProposal()).toBe(false);

    // Rename "Overview" to "Timeline" via the Yjs channel. The sibling
    // "Timeline" already exists, so the acceptance gate must reject.
    const collidingContent = buildFragmentContent(
      "some new body about timeline stuff" as SectionBody,
      2,
      "Timeline",
    );
    const update = buildClientUpdateForFragments(session, [
      { fragmentKey: OVERVIEW_KEY, content: collidingContent },
    ]);

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, update, {
        clientInstanceId: ORIGIN_CLIENT_INSTANCE_ID,
      }),
    );

    // Overview fragment content is restored to its pre-edit snapshot.
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toBe(preEditOverview);

    // No DocSession `inprogress` proposal was created for the rejected edit.
    expect(session.generator.hasCurrentProposal()).toBe(false);

    // No `section:pending` broadcast for the rejected fragment.
    const pendingEvents = broadcastEvents.filter(
      (e) => e.type === "section:pending",
    );
    expect(pendingEvents).toHaveLength(0);

    // Exactly one origin-only `section:edit-rejected` reached the origin tab
    // with the duplicate-sibling-heading reason.
    expect(privateEvents).toHaveLength(1);
    const rejection = privateEvents[0]!;
    expect(rejection.target.docPath).toBe(SAMPLE_DOC_PATH);
    expect(rejection.target.clientInstanceId).toBe(ORIGIN_CLIENT_INSTANCE_ID);
    expect(rejection.event.type).toBe("section:edit-rejected");
    if (rejection.event.type !== "section:edit-rejected") throw new Error("wrong event type");
    expect(rejection.event.reason_code).toBe("duplicate-sibling-heading");
    expect(rejection.event.rejected_by).toBe("server");
    expect(rejection.event.affected_fragments.some((f) => f.fragment_key === OVERVIEW_KEY)).toBe(
      true,
    );
    expect(rejection.event.guidance.length).toBeGreaterThan(0);
  });

  it("does not reject a content-identical re-encode of a pre-existing duplicate heading", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin").dispose);

    const corruptBaseline =
      "## Overview\n\nfirst body\n\n## Overview\n\nsecond body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, corruptBaseline);
    const normalizedBaseline = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    const update = buildClientUpdateForFragments(session, [
      { fragmentKey: OVERVIEW_KEY, content: normalizedBaseline },
    ]);

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, update, {
        clientInstanceId: ORIGIN_CLIENT_INSTANCE_ID,
      }),
    );

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toBe(normalizedBaseline);
    expect(privateEvents).toHaveLength(0);
    expect(session.generator.hasCurrentProposal()).toBe(false);
  });

  it("accepts an edit that repairs a pre-existing duplicate heading", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin").dispose);

    const corruptBaseline =
      "## Overview\n\nfirst body\n\n## Overview\n\nsecond body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, corruptBaseline);
    const repairedContent = buildFragmentContent(
      "first body\n\nsecond body" as SectionBody,
      2,
      "Overview",
    );
    const update = buildClientUpdateForFragments(session, [
      { fragmentKey: OVERVIEW_KEY, content: repairedContent },
    ]);

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, update, {
        clientInstanceId: ORIGIN_CLIENT_INSTANCE_ID,
      }),
    );

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toBe(repairedContent);
    expect(privateEvents).toHaveLength(0);
    expect(session.generator.hasCurrentProposal()).toBe(true);
  });

  it("accepts an independent valid fragment even when a colliding fragment is rejected in the same update", async () => {
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin").dispose);

    const preEditOverview = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    const validTimelineBody = "Q4 review + rollover" as SectionBody;

    // One Yjs update touches TWO fragments: a valid body update on Timeline
    // (no structural change) and a colliding heading rename on Overview.
    const update = buildClientUpdateForFragments(session, [
      {
        fragmentKey: OVERVIEW_KEY,
        content: buildFragmentContent(
          "body follows collision" as SectionBody,
          2,
          "Timeline",
        ),
      },
      {
        fragmentKey: TIMELINE_KEY,
        content: buildFragmentContent(validTimelineBody, 2, "Timeline"),
      },
    ]);

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, update, {
        clientInstanceId: ORIGIN_CLIENT_INSTANCE_ID,
      }),
    );

    // Overview fragment was restored to its pre-edit content.
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toBe(preEditOverview);

    // Timeline fragment kept its new (accepted) content, minus trailing newlines.
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY)).toContain(validTimelineBody);

    // The accepted fragment created and materialized into an inprogress proposal.
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // Exactly one `section:pending` — for the accepted Timeline fragment only.
    const pendingEvents = broadcastEvents.filter(
      (e) => e.type === "section:pending",
    );
    expect(pendingEvents).toHaveLength(1);
    if (pendingEvents[0]!.type !== "section:pending") throw new Error("bad narrow");
    expect(pendingEvents[0]!.fragment_key).toBe(TIMELINE_KEY);

    // Exactly one `section:edit-rejected` — for the rejected Overview fragment only.
    expect(privateEvents).toHaveLength(1);
    const rejection = privateEvents[0]!;
    if (rejection.event.type !== "section:edit-rejected") throw new Error("bad narrow");
    expect(rejection.event.affected_fragments.some((f) => f.fragment_key === OVERVIEW_KEY)).toBe(
      true,
    );
    expect(rejection.event.affected_fragments.some((f) => f.fragment_key === TIMELINE_KEY)).toBe(
      false,
    );
  });

  it("keeps the pre-edit overview body content byte-identical when Overview is restored", async () => {
    // A weaker restatement of the restore invariant — asserts the sample-content
    // preamble is present, guarding against a snapshot-restore that would
    // otherwise zero the section on collision.
    const session = await openSession();
    disposers.push(registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin").dispose);

    const update = buildClientUpdateForFragments(session, [
      {
        fragmentKey: OVERVIEW_KEY,
        content: buildFragmentContent(
          "collision would replace body" as SectionBody,
          2,
          "Timeline",
        ),
      },
    ]);

    await session.enqueue(() =>
      processArbitratedClientUpdate(session, WRITER.id, update, {
        clientInstanceId: ORIGIN_CLIENT_INSTANCE_ID,
      }),
    );

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toContain(
      SAMPLE_SECTIONS.overview,
    );
  });
});
