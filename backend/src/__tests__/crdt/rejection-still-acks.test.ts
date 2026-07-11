/**
 * A CRDT client update that the acceptance gate rejects (duplicate sibling
 * heading) MUST still receive an ordinary transport ack — otherwise the origin
 * client's send loop stays stuck in a syncing state and never re-tries. This
 * test drives frames through the binary CRDT message handler and asserts the
 * ack watermark advances the same way it does for accepted updates.
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
  setCrdtPrivateEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { encodeUpdate, decodeMessage, MSG_UPDATE_ACK } from "../../ws/crdt-ws-frames.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-origin");
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

function decodeAck(data: Uint8Array): number | null {
  const decoded = decodeMessage(data);
  if (decoded?.type !== MSG_UPDATE_ACK) return null;
  const p = decoded.payload;
  return (p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!;
}

describe("CRDT rejection preserves the origin-socket transport ack", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
    setCrdtPrivateEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    setCrdtPrivateEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("advances MSG_UPDATE_ACK exactly the same way for accepted and rejected updates", async () => {
    const session = await openSession();

    // Track every ACK sent to the origin socket, in order.
    const acks: number[] = [];
    const origin = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin", (data) => {
      const count = decodeAck(data);
      if (count !== null) acks.push(count);
    });
    disposers.push(origin.dispose);

    // Frame 1: an ACCEPTED body edit on Timeline (no structural change).
    const acceptedUpdate = buildClientUpdate(
      session,
      TIMELINE_KEY,
      buildFragmentContent("valid body update" as SectionBody, 2, "Timeline"),
    );
    await handleMessageForTest(origin.socket, origin.state, Buffer.from(encodeUpdate(acceptedUpdate)));

    // Frame 2: a REJECTED rename that would create a duplicate sibling heading.
    const rejectedUpdate = buildClientUpdate(
      session,
      OVERVIEW_KEY,
      buildFragmentContent("body follows collision" as SectionBody, 2, "Timeline"),
    );
    await handleMessageForTest(origin.socket, origin.state, Buffer.from(encodeUpdate(rejectedUpdate)));

    // Both frames — accepted AND rejected — produced exactly one ack each, in
    // strict monotonic order (Guarantee A watermark). If rejection had short-
    // circuited the ack path, `acks.length` would be 1 here.
    expect(acks).toEqual([1, 2]);
  });

  it("issues the ack for a rejected duplicate-heading update as the sole first frame", async () => {
    const session = await openSession();
    const acks: number[] = [];
    const origin = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-origin", (data) => {
      const count = decodeAck(data);
      if (count !== null) acks.push(count);
    });
    disposers.push(origin.dispose);

    // The very first frame is a rejection. It must still receive ack #1 so the
    // origin client doesn't remain "syncing" forever waiting on a watermark.
    const update = buildClientUpdate(
      session,
      OVERVIEW_KEY,
      buildFragmentContent("body" as SectionBody, 2, "Timeline"),
    );
    await handleMessageForTest(origin.socket, origin.state, Buffer.from(encodeUpdate(update)));

    expect(acks).toEqual([1]);
  });
});
