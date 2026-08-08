import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WebSocket } from "ws";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument } from "../helpers/sample-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  acquireDocSession,
  releaseDocSession,
  invalidateSessionForReplacement,
  setBroadcastSessionReplacementInvalidation,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { joinAndNotify } from "../../ws/crdt-ws-coordinator.js";
import type { CrdtSocketState } from "../../ws/crdt-transport.js";
import type { WriterIdentity } from "../../types/shared.js";

const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;

const WRITER_A: WriterIdentity = { id: "writer-a", type: "human", displayName: "Writer A" };

// Each test uses a unique docPath to isolate restore-notification module state.
const DOC_NO_NOTIFY = "/test/join-no-notify.md";
const DOC_RESTORE_ORDER = "/test/join-restore-order.md";
const DOC_DOUBLE_CALL = "/test/join-double-call.md";
const DOC_JSON_PAYLOAD = "/test/join-json-payload.md";

/** Build a minimal mock WebSocket sufficient for joinAndNotify. */
function createMockSocket(): { socket: WebSocket; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const socket = {
    readyState: 1, // WebSocket.OPEN
    send: (data: Uint8Array) => {
      sent.push(new Uint8Array(data));
    },
    close: () => {},
  } as unknown as WebSocket;
  return { socket, sent };
}

/** Build a minimal CrdtSocketState for joinAndNotify. */
function createSocketState(docPath: string, writerId: string, previousDocSessionId: string | null = null): CrdtSocketState {
  return {
    clientInstanceId: "test-instance" as CrdtSocketState["clientInstanceId"],
    writerId,
    writerType: "human",
    writerDisplayName: "Writer A",
    docPath,
    socketRole: "editor",
    requestedMode: "editor",
    attachmentState: "attached",
    docSessionId: null,
    previousDocSessionId,
    editorFocusTarget: null,
    tokenExp: Infinity,
    canRead: true,
    canWrite: true,
    socketId: "sock-test",
    joined: false,
  };
}

describe("joinAndNotify message ordering", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    // Create one sample doc per scenario so tests don't share notification state
    await createSampleDocument(ctx.rootDir, DOC_NO_NOTIFY);
    await createSampleDocument(ctx.rootDir, DOC_RESTORE_ORDER);
    await createSampleDocument(ctx.rootDir, DOC_DOUBLE_CALL);
    await createSampleDocument(ctx.rootDir, DOC_JSON_PAYLOAD);
    baseHead = await getHeadSha(ctx.rootDir);
    setBroadcastSessionReplacementInvalidation(() => {});
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("when a replacement notice is pending, MSG_DOCUMENT_REPLACEMENT_NOTICE (0x0B) is sent BEFORE the live-sections bootstrap (0x14)", async () => {
    const displaced = await acquireDocSession(DOC_RESTORE_ORDER, WRITER_A.id, baseHead, WRITER_A, "sock-displaced");
    const displacedId = displaced.liveYDocId;
    await invalidateSessionForReplacement(DOC_RESTORE_ORDER, {
      message: "document was restored to an earlier version",
    });

    // invalidation destroys any existing session — acquire fresh
    const session: DocSession = await acquireDocSession(DOC_RESTORE_ORDER, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_RESTORE_ORDER, WRITER_A.id, displacedId);

    try {
      joinAndNotify(session, socket, st);
      await session.enqueue(() => undefined); // drain the lane so the bootstrap send lands

      const restoreIdx = sent.findIndex((m) => m[0] === MSG_DOCUMENT_REPLACEMENT_NOTICE);
      const bootstrapIdx = sent.findIndex((m) => m[0] === MSG_LIVE_SECTIONS_BOOTSTRAP);

      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
      expect(restoreIdx).toBeLessThan(bootstrapIdx);
    } finally {
      await releaseDocSession(DOC_RESTORE_ORDER, WRITER_A.id, "sock-test");
    }
  });

  it("when no replacement notice is pending, the live-sections bootstrap is the ONLY join message — no join-time SYNC_STEP_2/SYNC_STEP_1", async () => {
    const session = await acquireDocSession(DOC_NO_NOTIFY, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_NO_NOTIFY, WRITER_A.id);

    try {
      joinAndNotify(session, socket, st);
      await session.enqueue(() => undefined); // drain the lane so the bootstrap send lands

      expect(sent.length).toBe(1);
      expect(sent[0][0]).toBe(MSG_LIVE_SECTIONS_BOOTSTRAP);
      // Join body fill contract: a join-time full-doc SYNC_STEP_2 (or the
      // SYNC_STEP_1 that solicited it) would be a second join body authority.
      expect(sent.find((m) => m[0] === MSG_SYNC_STEP_2)).toBeUndefined();
      expect(sent.find((m) => m[0] === MSG_SYNC_STEP_1)).toBeUndefined();
      expect(sent.find((m) => m[0] === MSG_DOCUMENT_REPLACEMENT_NOTICE)).toBeUndefined();
    } finally {
      await releaseDocSession(DOC_NO_NOTIFY, WRITER_A.id, "sock-test");
    }
  });

  it("double-call is a no-op — second joinAndNotify sends nothing", async () => {
    const session = await acquireDocSession(DOC_DOUBLE_CALL, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_DOUBLE_CALL, WRITER_A.id);

    try {
      joinAndNotify(session, socket, st);
      await session.enqueue(() => undefined); // drain the lane so the bootstrap send lands
      const firstCallCount = sent.length;
      expect(firstCallCount).toBeGreaterThan(0);
      expect(st.joined).toBe(true);

      joinAndNotify(session, socket, st);
      await session.enqueue(() => undefined);
      expect(sent.length).toBe(firstCallCount);
    } finally {
      await releaseDocSession(DOC_DOUBLE_CALL, WRITER_A.id, "sock-test");
    }
  });

  it("MSG_DOCUMENT_REPLACEMENT_NOTICE payload is valid JSON with expected fields", async () => {
    const displaced = await acquireDocSession(DOC_JSON_PAYLOAD, WRITER_A.id, baseHead, WRITER_A, "sock-displaced");
    const displacedId = displaced.liveYDocId;
    await invalidateSessionForReplacement(DOC_JSON_PAYLOAD, {
      message: "admin overwrote this document",
    });
    const session = await acquireDocSession(DOC_JSON_PAYLOAD, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_JSON_PAYLOAD, WRITER_A.id, displacedId);

    try {
      joinAndNotify(session, socket, st);

      const restoreMsg = sent.find((m) => m[0] === MSG_DOCUMENT_REPLACEMENT_NOTICE);
      expect(restoreMsg).toBeDefined();

      const payload = restoreMsg!.slice(1);
      const json = JSON.parse(new TextDecoder().decode(payload));
      expect(json).toHaveProperty("message");
      expect(json.message).toBe("admin overwrote this document");
    } finally {
      await releaseDocSession(DOC_JSON_PAYLOAD, WRITER_A.id, "sock-test");
    }
  });
});
