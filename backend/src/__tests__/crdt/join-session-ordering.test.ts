import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  acquireDocSession,
  joinSession,
  releaseDocSession,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import type { WsServerEvent, WriterIdentity } from "../../types/shared.js";

const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;

const WRITER_A: WriterIdentity = { id: "writer-a", type: "human", displayName: "Writer A" };
const WRITER_B: WriterIdentity = { id: "writer-b", type: "human", displayName: "Writer B" };

describe("joinSession message ordering", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function acquireAndJoin(): Promise<{
    session: DocSession;
    messages: Uint8Array[];
    presenceEvents: WsServerEvent[];
  }> {
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER_A.id, baseHead, WRITER_A, "sock-a");
    const messages: Uint8Array[] = [];
    const presenceEvents: WsServerEvent[] = [];
    joinSession(session, (msg) => messages.push(msg), (evt) => presenceEvents.push(evt));
    return { session, messages, presenceEvents };
  }

  it("sends SYNC_STEP_2 (0x01) as the first message", async () => {
    const { session, messages } = await acquireAndJoin();
    try {
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0][0]).toBe(MSG_SYNC_STEP_2);
    } finally {
      await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    }
  });

  it("sends SYNC_STEP_1 (0x00) as the second message", async () => {
    const { session, messages } = await acquireAndJoin();
    try {
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[1][0]).toBe(MSG_SYNC_STEP_1);
    } finally {
      await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    }
  });

  it("sends exactly 2 messages when no presence exists", async () => {
    const { session, messages, presenceEvents } = await acquireAndJoin();
    try {
      expect(messages.length).toBe(2);
      expect(presenceEvents.length).toBe(0);
    } finally {
      await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    }
  });

  it("SYNC_STEP_2 contains valid Y.Doc state", async () => {
    const { session, messages } = await acquireAndJoin();
    try {
      const payload = messages[0].slice(1);
      const receiverDoc = new Y.Doc();
      Y.applyUpdate(receiverDoc, payload);
      // The doc should have fragment keys matching the source session
      const sourceKeys = Array.from(session.fragments.ydoc.share.keys()).sort();
      const receiverKeys = Array.from(receiverDoc.share.keys()).sort();
      expect(receiverKeys).toEqual(sourceKeys);
    } finally {
      await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    }
  });

  it("emits presence events after sync messages", async () => {
    // Acquire session with writer A
    const session = await acquireDocSession(SAMPLE_DOC_PATH, WRITER_A.id, baseHead, WRITER_A, "sock-a");
    // Add writer B as a second editor with presence
    await acquireDocSession(SAMPLE_DOC_PATH, WRITER_B.id, baseHead, WRITER_B, "sock-b");
    session.presenceManager.setFocus(WRITER_B.id, ["Overview"]);

    // Now join a new socket and record ordering
    const log: string[] = [];
    joinSession(
      session,
      () => log.push("sendRaw"),
      () => log.push("emitPresence"),
    );

    try {
      // All sendRaw calls should come before any emitPresence
      const firstPresenceIdx = log.indexOf("emitPresence");
      const lastSendRawIdx = log.lastIndexOf("sendRaw");
      expect(firstPresenceIdx).toBeGreaterThan(-1);
      expect(lastSendRawIdx).toBeLessThan(firstPresenceIdx);
    } finally {
      await releaseDocSession(SAMPLE_DOC_PATH, WRITER_B.id, "sock-b");
      await releaseDocSession(SAMPLE_DOC_PATH, WRITER_A.id, "sock-a");
    }
  });
});
