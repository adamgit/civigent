import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WebSocket } from "ws";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument } from "../helpers/sample-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  acquireDocSession,
  releaseDocSession,
  invalidateSessionForRestore,
  setBroadcastRestoreInvalidation,
  type DocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { joinAndNotify } from "../../ws/crdt-coordinator.js";
import type { CrdtSocketState } from "../../ws/crdt-transport.js";
import type { WriterIdentity } from "../../types/shared.js";

const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_RESTORE_NOTIFICATION = 0x0b;

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
function createSocketState(docPath: string, writerId: string): CrdtSocketState {
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
    setBroadcastRestoreInvalidation(() => {});
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("when restore notification is pending, MSG_RESTORE_NOTIFICATION (0x0B) is sent BEFORE SYNC_STEP_2 (0x01)", async () => {
    // Pre-populate a pending restore notification for this docPath/writerId
    await invalidateSessionForRestore(DOC_RESTORE_ORDER, "sha-restored", "Admin", {
      committedSha: "sha-precommit",
      affectedWriters: [{ writerId: WRITER_A.id, dirtyHeadingPaths: [["Overview"]] }],
    });

    // invalidateSessionForRestore destroys any existing session — acquire fresh
    const session: DocSession = await acquireDocSession(DOC_RESTORE_ORDER, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_RESTORE_ORDER, WRITER_A.id);

    try {
      joinAndNotify(session, socket, st);

      const restoreIdx = sent.findIndex((m) => m[0] === MSG_RESTORE_NOTIFICATION);
      const syncStep2Idx = sent.findIndex((m) => m[0] === MSG_SYNC_STEP_2);

      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(syncStep2Idx).toBeGreaterThanOrEqual(0);
      // EXPECTED TO FAIL pre-fix: currently restoreIdx > syncStep2Idx
      expect(restoreIdx).toBeLessThan(syncStep2Idx);
    } finally {
      await releaseDocSession(DOC_RESTORE_ORDER, WRITER_A.id, "sock-test");
    }
  });

  it("when no restore notification is pending, only SYNC_STEP_2 and SYNC_STEP_1 are sent", async () => {
    const session = await acquireDocSession(DOC_NO_NOTIFY, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_NO_NOTIFY, WRITER_A.id);

    try {
      joinAndNotify(session, socket, st);

      expect(sent.length).toBe(2);
      expect(sent[0][0]).toBe(MSG_SYNC_STEP_2);
      expect(sent[1][0]).toBe(MSG_SYNC_STEP_1);
      expect(sent.find((m) => m[0] === MSG_RESTORE_NOTIFICATION)).toBeUndefined();
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
      const firstCallCount = sent.length;
      expect(firstCallCount).toBeGreaterThan(0);
      expect(st.joined).toBe(true);

      joinAndNotify(session, socket, st);
      expect(sent.length).toBe(firstCallCount);
    } finally {
      await releaseDocSession(DOC_DOUBLE_CALL, WRITER_A.id, "sock-test");
    }
  });

  it("MSG_RESTORE_NOTIFICATION payload is valid JSON with expected fields", async () => {
    await invalidateSessionForRestore(DOC_JSON_PAYLOAD, "sha-restored-2", "Admin2", {
      committedSha: "sha-precommit-2",
      affectedWriters: [{ writerId: WRITER_A.id, dirtyHeadingPaths: [["Section"]] }],
    });
    const session = await acquireDocSession(DOC_JSON_PAYLOAD, WRITER_A.id, baseHead, WRITER_A, "sock-test");
    const { socket, sent } = createMockSocket();
    const st = createSocketState(DOC_JSON_PAYLOAD, WRITER_A.id);

    try {
      joinAndNotify(session, socket, st);

      const restoreMsg = sent.find((m) => m[0] === MSG_RESTORE_NOTIFICATION);
      expect(restoreMsg).toBeDefined();

      const payload = restoreMsg!.slice(1);
      const json = JSON.parse(new TextDecoder().decode(payload));
      expect(json).toHaveProperty("restored_sha");
      expect(json).toHaveProperty("restored_by_display_name");
      expect(json).toHaveProperty("pre_commit_sha");
      expect(json).toHaveProperty("your_dirty_heading_paths");
      expect(json.restored_sha).toBe("sha-restored-2");
      expect(json.restored_by_display_name).toBe("Admin2");
    } finally {
      await releaseDocSession(DOC_JSON_PAYLOAD, WRITER_A.id, "sock-test");
    }
  });
});
