/**
 * Regression coverage for the backend-authority sync invariant:
 * client document mutations must enter through MSG_YJS_UPDATE, never through
 * a client-to-server MSG_SYNC_STEP_2 reply.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getDataRoot } from "../../storage/data-root.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  handleMessageForTest,
  registerFakeEditorSocketForTest,
  registerFakeObserverSocketForTest,
  resetCoordinatorPublishStateForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { MSG_SYNC_STEP_2 } from "../../ws/crdt-ws-frames.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-owner");
}

function encodeClientSyncStep2(payload: Uint8Array): Buffer {
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = MSG_SYNC_STEP_2;
  frame.set(payload, 1);
  return Buffer.from(frame);
}

function buildClientSyncStep2Payload(
  session: DocSession,
  fragmentKey: string,
  content: FragmentContent,
): Uint8Array {
  const clientDoc = new Y.Doc();
  Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc));
  const clientStore = new LiveFragmentStringsStore(
    clientDoc,
    session.liveFragments.getFragmentKeys(),
    SAMPLE_DOC_PATH,
  );
  clientStore.replaceFragmentString(fragmentKey, content);
  const update = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(session.ydoc));
  clientDoc.destroy();
  return update;
}

describe("client MSG_SYNC_STEP_2 is not an authoritative write", () => {
  let ctx: TempDataRootContext;
  let events: WsServerEvent[] = [];
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    events = [];
    setCrdtEventHandler((event) => events.push(event));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    resetCoordinatorPublishStateForTest();
    destroyAllSessions();
    setCrdtEventHandler(() => undefined);
    await ctx.cleanup();
  });

  it("ignores an editor client's MSG_SYNC_STEP_2 payload instead of mutating the server Y.Doc", async () => {
    const session = await openSession();
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-editor");
    disposers.push(editor.dispose);

    const before = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    const duplicated = (
      "## Overview\n\nThe overview covers our strategic goals.\n\n" +
      "## Overview\n\nThe overview covers our strategic goals."
    ) as FragmentContent;
    const payload = buildClientSyncStep2Payload(session, OVERVIEW_KEY, duplicated);

    await handleMessageForTest(editor.socket, editor.state, encodeClientSyncStep2(payload));

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toBe(before);
    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(events.filter((event) => event.type === "section:pending")).toHaveLength(0);
  });

  it("ignores an observer client's MSG_SYNC_STEP_2 reply without rejecting the socket", async () => {
    const session = await openSession();
    const closed: Array<{ code: number; reason: string }> = [];
    const observer = registerFakeObserverSocketForTest(
      SAMPLE_DOC_PATH,
      "sock-observer",
      (code, reason) => closed.push({ code, reason }),
    );
    disposers.push(observer.dispose);

    const before = session.liveFragments.readFragmentString(OVERVIEW_KEY);
    const attempted = "## Overview\n\nobserver sync content must not win" as FragmentContent;
    const payload = buildClientSyncStep2Payload(session, OVERVIEW_KEY, attempted);

    await expect(
      handleMessageForTest(observer.socket, observer.state, encodeClientSyncStep2(payload)),
    ).resolves.toBeUndefined();

    expect(closed).toHaveLength(0);
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY)).toBe(before);
    expect(session.generator.hasCurrentProposal()).toBe(false);
    expect(events.filter((event) => event.type === "section:pending")).toHaveLength(0);
  });
});
