/**
 * CRDT session coordinator — maps binary protocol messages to session operations.
 *
 * Imports from both crdt-transport (socket auth state) and crdt-protocol (message
 * constants and encode/decode). Never calls socket.send() directly — calls
 * sendToSocket (transport abstraction) instead.
 *
 * Per-doc socket tracking lives here (docSockets), not in crdt-transport.
 * Socket role (editor vs observer) is tracked in CrdtSocketState.socketRole — not in DocSession.holders.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { resolveWriterWithExpiry } from "../auth/context.js";
import { checkDocPermission } from "../auth/acl.js";
import {
  lookupDocSession,
  acquireDocSession,
  releaseDocSession,
  getDocSessionId,
  updateSectionFocus,
  joinSession,
  updateActivity,
  updateEditPulse,
  markFragmentDirty,
  triggerDebouncedFlush,
  normalizeFragment,
  setFlushCallback,
  setNormalizeBroadcast,
  setYjsUpdateBroadcast,
  setPostCommitNotify,
  injectAfterCommit,
  setIdleTimeoutHandler,
  addObserverHolder,
  removeObserverHolder,
  countEditorSockets,
  addContributor,
  getPendingRestoreNotification,
  setBroadcastRestoreInvalidation,
  type DocSession,
} from "../crdt/ydoc-lifecycle.js";
import { setPostCommitHook } from "../storage/commit-pipeline.js";
import { FragmentStore } from "../crdt/fragment-store.js";
import { getHeadSha } from "../storage/git-repo.js";
import { getDataRoot } from "../storage/data-root.js";
import { flushDocSessionToDisk, commitSessionFilesToCanonical, cleanupSessionFiles } from "../storage/session-store.js";
import type { WsServerEvent, WriterIdentity } from "../types/shared.js";
import type { ClientInstanceId, RemoteParticipant, ModeTransitionRequest, ModeTransitionResult } from "../types/shared.js";
import {
  MSG_SYNC_STEP_1,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_SECTION_FOCUS,
  MSG_ACTIVITY_PULSE,
  MSG_SECTION_MUTATE,
  MSG_MODE_TRANSITION_REQUEST,
  encodeSyncStep2,
  encodeUpdate,
  encodeSessionFlushStarted,
  encodeSessionFlushed,
  encodeStructureWillChange,
  encodeMutateResult,
  encodeRestoreNotification,
  encodeModeTransitionResult,
  decodeMessage,
  parseCrdtUrl,
  WS_CLOSE_DOCUMENT_RESTORED,
  WS_CLOSE_SUPERSEDED,
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_IDLE_TIMEOUT,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTHORIZATION_FAILED,
  WS_CLOSE_REASON_MAX_LENGTH,
} from "./crdt-protocol.js";
import {
  CrdtSocketState,
  socketState,
  sendToSocket,
  checkTokenExpired,
  rejectUpgrade,
} from "./crdt-transport.js";

// ─── Per-doc socket tracking ─────────────────────────────────────
// Replaces docClients from crdt-transport. Owned by coordinator because it
// must remain in sync with session holder lifecycle (see addObserverHolder).

const docSockets = new Map<string, Set<WebSocket>>();
const participants = new Map<ClientInstanceId, RemoteParticipant>();

function setParticipantFromSocketState(state: CrdtSocketState): void {
  participants.set(state.clientInstanceId, {
    clientInstanceId: state.clientInstanceId,
    writerId: state.writerId,
    docPath: state.docPath,
    clientRole: state.socketRole,
    requestedMode: state.requestedMode,
    attachmentState: state.attachmentState,
    docSessionId: state.docSessionId,
    editorFocusTarget: state.editorFocusTarget,
  });
}

function updateParticipant(
  clientInstanceId: ClientInstanceId,
  patch: Partial<Pick<RemoteParticipant, "clientRole" | "requestedMode" | "attachmentState" | "docSessionId" | "editorFocusTarget">>,
): void {
  const existing = participants.get(clientInstanceId);
  if (!existing) return;
  participants.set(clientInstanceId, { ...existing, ...patch });
}

function removeParticipant(clientInstanceId: ClientInstanceId): void {
  participants.delete(clientInstanceId);
}

/**
 * Guard-and-join helper: joins a session for a socket if not already joined,
 * then delivers any pending restore notification.
 */
function joinAndNotify(session: DocSession, socket: WebSocket, st: CrdtSocketState): void {
  if (st.joined) return;
  joinSession(session, (msg) => socket.send(msg), (event) => { if (onWsEvent) onWsEvent(event); });
  st.joined = true;
  const notification = getPendingRestoreNotification(st.docPath, st.writerId);
  if (notification) sendToSocket(socket, encodeRestoreNotification(notification));
}

function addSocket(docPath: string, socket: WebSocket): void {
  let sockets = docSockets.get(docPath);
  if (!sockets) {
    sockets = new Set();
    docSockets.set(docPath, sockets);
  }
  sockets.add(socket);
}

function removeSocket(docPath: string, socket: WebSocket): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) {
    docSockets.delete(docPath);
  }
}

/**
 * Close all connected CRDT sockets for a document with code 4022 (document restored).
 * Clients treat 4022 as an immediate reconnect trigger (no exponential backoff).
 * This is the only place in the codebase that sends close code 4022.
 */
export function broadcastRestoreInvalidation(docPath: string): void {
  for (const socket of docSockets.get(docPath) ?? []) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(WS_CLOSE_DOCUMENT_RESTORED, "document restored");
    }
  }
}

function broadcastToOthers(docPath: string, sender: WebSocket, data: Uint8Array): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const s of sockets) {
    if (s !== sender && s.readyState === WebSocket.OPEN) {
      s.send(data);
    }
  }
}

export function broadcastToAll(docPath: string, data: Uint8Array): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const s of sockets) {
    if (s.readyState === WebSocket.OPEN) {
      s.send(data);
    }
  }
}

// ─── Event handler ──────────────────────────────────────────────

let onWsEvent: ((event: WsServerEvent) => void) | null = null;

export function setCrdtEventHandler(handler: (event: WsServerEvent) => void): void {
  onWsEvent = handler;
}

// ─── Message handler ────────────────────────────────────────────

async function finalizeSessionEnd(state: CrdtSocketState, result: Awaited<ReturnType<typeof releaseDocSession>>): Promise<void> {
  if (!result.sessionEnded) return;
  // Build contributors list: the disconnecting editor is primary; others from session.
  const primaryWriter: WriterIdentity = {
    id: state.writerId,
    type: state.writerType,
    displayName: state.writerDisplayName,
  };
  const contributors: WriterIdentity[] = [
    primaryWriter,
    ...result.contributors.filter((c) => c.id !== state.writerId),
  ];
  const commitResult = await commitSessionFilesToCanonical(contributors, state.docPath);
  if (commitResult.skeletonErrors.length > 0) {
    throw new Error(
      `Session commit skipped for ${state.docPath}: corrupt overlay skeleton. ` +
      `Session files preserved on disk. Remove the corrupt overlay to recover.\n` +
      commitResult.skeletonErrors.map(e => e.error).join("\n"),
    );
  }
  if (commitResult.sectionsCommitted > 0) {
    await cleanupSessionFiles(state.docPath);
    if (onWsEvent && commitResult.commitSha) {
      onWsEvent({
        type: "content:committed",
        doc_path: state.docPath,
        sections: commitResult.committedSections,
        commit_sha: commitResult.commitSha,
        writer_id: contributors[0].id,
        writer_display_name: contributors[0].displayName,
        writer_type: contributors[0].type,
        contributor_ids: contributors.map((c) => c.id),
        seconds_ago: 0,
      });

      // Emit dirty:changed for all contributors so each frontend can clear its dirty state.
      for (const contributor of contributors) {
        for (const section of commitResult.committedSections) {
          onWsEvent({
            type: "dirty:changed",
            writer_id: contributor.id,
            doc_path: section.doc_path,
            heading_path: section.heading_path,
            dirty: false,
            base_head: null,
            committed_head: commitResult.commitSha,
          });
        }
      }
    }
  }

  closeObserversForDoc(state.docPath, 4021, "session_ended");
}

async function applyModeTransition(
  socket: WebSocket,
  state: CrdtSocketState,
  request: ModeTransitionRequest,
): Promise<ModeTransitionResult> {
  if (request.clientInstanceId !== state.clientInstanceId) {
    return {
      kind: "rejected",
      requestId: request.requestId,
      clientInstanceId: state.clientInstanceId,
      requestedMode: request.requestedMode,
      attachmentState: state.attachmentState,
      docSessionId: state.docSessionId,
      clientRole: state.socketRole,
      reason: "clientInstanceId mismatch",
    };
  }

  state.requestedMode = request.requestedMode;
  state.editorFocusTarget = request.editorFocusTarget;

  if (request.requestedMode === "none") {
    if (state.socketRole === "observer") {
      removeObserverHolder(state.docPath, state.writerId, state.socketId);
    } else {
      const releaseResult = await releaseDocSession(state.docPath, state.writerId, state.socketId);
      await finalizeSessionEnd(state, releaseResult);
    }
    state.attachmentState = "detached";
    state.docSessionId = null;
    updateParticipant(state.clientInstanceId, {
      requestedMode: state.requestedMode,
      editorFocusTarget: state.editorFocusTarget,
      attachmentState: state.attachmentState,
      docSessionId: null,
    });
    return {
      kind: "success",
      requestId: request.requestId,
      clientInstanceId: state.clientInstanceId,
      requestedMode: "none",
      attachmentState: "detached",
      docSessionId: null,
      clientRole: null,
    };
  }

  if (request.requestedMode === "observer") {
    if (!state.canRead) {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Read permission required for observer mode",
      };
    }
    if (state.socketRole === "editor") {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Transition to observer requires requesting none first",
      };
    }

    const session = lookupDocSession(state.docPath);
    state.socketRole = "observer";
    if (session) {
      addObserverHolder(session, state.writerId, {
        id: state.writerId,
        type: state.writerType,
        displayName: state.writerDisplayName,
      }, state.socketId);
      joinAndNotify(session, socket, state);
      state.docSessionId = session.docSessionId;
      state.attachmentState = "attached_to_session";
    } else {
      state.docSessionId = null;
      state.attachmentState = "waiting_for_session";
    }
  } else {
    if (!state.canWrite) {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Write permission required for editor mode",
      };
    }
    if (state.socketRole === "observer") {
      return {
        kind: "rejected",
        requestId: request.requestId,
        clientInstanceId: state.clientInstanceId,
        requestedMode: request.requestedMode,
        attachmentState: state.attachmentState,
        docSessionId: state.docSessionId,
        clientRole: state.socketRole,
        reason: "Transition to editor requires requesting none first",
      };
    }
    // Enforce single editor socket per user per document.
    for (const existingSocket of docSockets.get(state.docPath) ?? []) {
      if (existingSocket === socket) continue;
      const st = socketState.get(existingSocket);
      if (st?.writerId === state.writerId && st?.socketRole === "editor" && existingSocket.readyState === WebSocket.OPEN) {
        existingSocket.close(WS_CLOSE_SUPERSEDED, "superseded_by_new_tab");
      }
    }
    const baseHead = await getHeadSha(getDataRoot());
    const session = await acquireDocSession(
      state.docPath,
      state.writerId,
      baseHead,
      { id: state.writerId, type: state.writerType, displayName: state.writerDisplayName },
      state.socketId,
    );
    state.socketRole = "editor";
    state.docSessionId = session.docSessionId;
    state.attachmentState = "attached_to_session";

    joinAndNotify(session, socket, state);

    // First editor in session: attach waiting observers.
    if (countEditorSockets(session) === 1) {
      for (const client of docSockets.get(state.docPath) ?? []) {
        if (client === socket) continue;
        const st = socketState.get(client);
        if (!st || st.socketRole !== "observer" || st.joined || client.readyState !== WebSocket.OPEN) continue;
        addObserverHolder(session, st.writerId, {
          id: st.writerId,
          type: st.writerType,
          displayName: st.writerDisplayName,
        }, st.socketId);
        st.docSessionId = session.docSessionId;
        st.attachmentState = "attached_to_session";
        joinAndNotify(session, client, st);
        updateParticipant(st.clientInstanceId, {
          attachmentState: "attached_to_session",
          docSessionId: session.docSessionId,
        });
      }
    }
  }

  updateParticipant(state.clientInstanceId, {
    requestedMode: state.requestedMode,
    editorFocusTarget: state.editorFocusTarget,
    attachmentState: state.attachmentState,
    docSessionId: state.docSessionId,
    clientRole: state.socketRole,
  });

  return {
    kind: "success",
    requestId: request.requestId,
    clientInstanceId: state.clientInstanceId,
    requestedMode: state.requestedMode,
    attachmentState: state.attachmentState,
    docSessionId: state.docSessionId,
    clientRole: state.socketRole,
  };
}

async function handleMessage(
  socket: WebSocket,
  state: CrdtSocketState,
  data: Buffer,
): Promise<void> {
  const decoded = decodeMessage(data);
  if (!decoded) return;

  const { type: msgType, payload } = decoded;

  const participant = participants.get(state.clientInstanceId);
  const effectiveRole = participant?.clientRole ?? state.socketRole;

  // Block write operations from observers (server-authoritative participant role).
  if (effectiveRole === "observer") {
    if (
      msgType === MSG_SYNC_STEP_2 ||
      msgType === MSG_YJS_UPDATE ||
      msgType === MSG_SECTION_FOCUS ||
      msgType === MSG_ACTIVITY_PULSE ||
      msgType === MSG_SECTION_MUTATE
    ) {
      return;
    }
  }
  if (state.requestedMode === "none" && msgType !== MSG_MODE_TRANSITION_REQUEST) {
    return;
  }

  const activeSession = lookupDocSession(state.docPath);
  const session = activeSession;
  const doc = session?.fragments.ydoc;

  if (!doc && msgType !== MSG_MODE_TRANSITION_REQUEST) {
    // While detached/waiting there is no doc to process sync/update messages against.
    return;
  }

  switch (msgType) {
    case MSG_MODE_TRANSITION_REQUEST: {
      let request: ModeTransitionRequest;
      try {
        request = JSON.parse(new TextDecoder().decode(payload)) as ModeTransitionRequest;
      } catch {
        const rejected: ModeTransitionResult = {
          kind: "rejected",
          requestId: "invalid",
          clientInstanceId: state.clientInstanceId,
          requestedMode: state.requestedMode,
          attachmentState: state.attachmentState,
          docSessionId: state.docSessionId,
          clientRole: state.socketRole,
          reason: "Invalid mode transition payload",
        };
        sendToSocket(socket, encodeModeTransitionResult(rejected));
        break;
      }
      const result = await applyModeTransition(socket, state, request);
      sendToSocket(socket, encodeModeTransitionResult(result));
      break;
    }
    case MSG_SYNC_STEP_1: {
      const response = encodeSyncStep2(doc!, payload);
      sendToSocket(socket, response);
      break;
    }
    case MSG_SYNC_STEP_2: {
      Y.applyUpdate(doc!, payload);
      break;
    }
    case MSG_YJS_UPDATE: {
      Y.applyUpdate(doc!, payload);
      broadcastToOthers(state.docPath, socket, encodeUpdate(payload));
      updateActivity(state.docPath);

      // Track which fragment this writer dirtied (for author metadata).
      const focusedPath = session!.presenceManager.getAll().get(state.writerId);
      if (focusedPath) {
        try {
          const entry = session!.fragments.skeleton.expect(focusedPath);
          const fragmentKey = FragmentStore.fragmentKeyFor(entry);
          session!.fragments.markDirty(fragmentKey);
          const isNewlyDirty = markFragmentDirty(state.docPath, state.writerId, fragmentKey);
          if (isNewlyDirty && onWsEvent) {
            onWsEvent({
              type: "dirty:changed",
              writer_id: state.writerId,
              doc_path: state.docPath,
              heading_path: focusedPath,
              dirty: true,
              base_head: session!.baseHead,
            });
          }
        } catch {
          // Skeleton resolve can fail during structural changes — skip dirty tracking
        }
      } else {
        // No focus set yet — mark only the fragments actually touched by this transaction
        for (const fragmentKey of session!.lastTouchedFragments) {
          session!.fragments.markDirty(fragmentKey);
          markFragmentDirty(state.docPath, state.writerId, fragmentKey);
        }
        session!.lastTouchedFragments.clear();
      }

      triggerDebouncedFlush(state.docPath);
      break;
    }
    case MSG_AWARENESS: {
      updateActivity(state.docPath);
      const buf = new Uint8Array(1 + payload.length);
      buf[0] = MSG_AWARENESS;
      buf.set(payload, 1);
      broadcastToOthers(state.docPath, socket, buf);
      break;
    }
    case MSG_SECTION_FOCUS: {
      const headingPath = new TextDecoder()
        .decode(payload)
        .split("\x00")
        .filter(Boolean);
      state.editorFocusTarget = headingPath.length > 0 ? { heading_path: headingPath } : null;
      updateParticipant(state.clientInstanceId, { editorFocusTarget: state.editorFocusTarget });

      const { oldFocus } = updateSectionFocus(state.docPath, state.writerId, headingPath);

      // Normalize the LEFT (old) fragment on focus change
      if (oldFocus) {
        const oldEntry = session!.fragments.skeleton.find(oldFocus);
        if (oldEntry) {
          const oldKey = FragmentStore.fragmentKeyFor(oldEntry);
          await normalizeFragment(state.docPath, oldKey);
        }
      }

      // Broadcast editingPresence events
      if (onWsEvent) {
        if (oldFocus) {
          onWsEvent({
            type: "presence:done",
            writer_id: state.writerId,
            writer_display_name: state.writerDisplayName,
            writer_type: state.writerType,
            doc_path: state.docPath,
            heading_path: oldFocus,
          });
        }
        onWsEvent({
          type: "presence:editing",
          doc_path: state.docPath,
          writer_id: state.writerId,
          writer_display_name: state.writerDisplayName,
          writer_type: state.writerType,
          heading_path: headingPath,
        });
      }
      break;
    }
    case MSG_ACTIVITY_PULSE: {
      updateEditPulse(state.docPath, state.writerId);
      addContributor(state.docPath, state.writerId, {
        id: state.writerId,
        type: state.writerType,
        displayName: state.writerDisplayName,
      });
      break;
    }
    case MSG_SECTION_MUTATE: {
      const json = new TextDecoder().decode(payload);
      let parsed: { fragmentKey: string; markdown: string };
      try {
        parsed = JSON.parse(json);
      } catch {
        sendToSocket(socket, encodeMutateResult(false, "Invalid JSON payload"));
        break;
      }

      const entry = session!.fragments.resolveEntryForKey(parsed.fragmentKey);
      if (!entry) {
        sendToSocket(socket, encodeMutateResult(false, `Fragment key not found: ${parsed.fragmentKey}`));
        break;
      }

      const svBefore = Y.encodeStateVector(doc!);
      session!.fragments.setFragmentContent(parsed.fragmentKey, parsed.markdown);
      session!.fragments.markDirty(parsed.fragmentKey);
      markFragmentDirty(state.docPath, state.writerId, parsed.fragmentKey);

      const update = Y.encodeStateAsUpdate(doc!, svBefore);
      if (update.length > 0) {
        broadcastToOthers(state.docPath, socket, encodeUpdate(update));
      }

      triggerDebouncedFlush(state.docPath);
      sendToSocket(socket, encodeMutateResult(true));
      break;
    }
  }
}

// ─── Flush-to-session callback ──────────────────────────────────

async function flushToSession(session: DocSession): Promise<void> {
  const hasDirtyFragments = session.fragments.dirtyKeys.size > 0;
  if (hasDirtyFragments) {
    broadcastToAll(session.docPath, encodeSessionFlushStarted());
  }

  const { writtenKeys, deletedKeys } = await flushDocSessionToDisk(session);

  if (writtenKeys.length > 0 || deletedKeys.length > 0) {
    broadcastToAll(session.docPath, encodeSessionFlushed(writtenKeys, deletedKeys));
    if (onWsEvent) {
      onWsEvent({ type: "session:flushed", doc_path: session.docPath });
    }
  }
}

setFlushCallback(flushToSession);

setNormalizeBroadcast((docPath, info) => {
  broadcastToAll(docPath, encodeStructureWillChange(info));
  if (onWsEvent) {
    onWsEvent({ type: "doc:structure-changed", doc_path: docPath });
  }
});

setPostCommitHook(async (docPath, headingPaths, meta) => {
  await injectAfterCommit(docPath, headingPaths, meta);
});

setYjsUpdateBroadcast((docPath, update) => {
  broadcastToAll(docPath, encodeUpdate(update));
});

setPostCommitNotify((docPath, proposalId, writerDisplayName, headingPaths) => {
  if (onWsEvent) {
    onWsEvent({
      type: "proposal:injected_into_session",
      doc_path: docPath,
      proposal_id: proposalId,
      writer_display_name: writerDisplayName,
      heading_paths: headingPaths,
    });
  }
});

// ─── Restore invalidation callback wiring ────────────────────────

setBroadcastRestoreInvalidation((docPath) => broadcastRestoreInvalidation(docPath));

// ─── Idle timeout ────────────────────────────────────────────────

setIdleTimeoutHandler((docPath: string) => {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  const session = lookupDocSession(docPath);
  for (const client of [...sockets]) {
    if (client.readyState === WebSocket.OPEN) {
      const st = socketState.get(client);
      if (st?.socketRole === "observer") {
        client.close(WS_CLOSE_SESSION_ENDED, "session_ended");
      } else {
        client.close(WS_CLOSE_IDLE_TIMEOUT, "idle_timeout");
      }
    }
  }
});

// ─── Observer close helper ───────────────────────────────────────

function closeObserversForDoc(docPath: string, code: number, reason: string): void {
  const sockets = docSockets.get(docPath);
  if (!sockets) return;
  for (const client of [...sockets]) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const st = socketState.get(client);
    if (st?.socketRole === "observer") {
      client.close(code, reason.slice(0, WS_CLOSE_REASON_MAX_LENGTH));
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

export interface CrdtWsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createCrdtWsServer(): CrdtWsServer {
  const wss = new WebSocketServer({ noServer: true });

  // ─── Unified connection handler ───────
  wss.on("connection", (socket: WebSocket, state: CrdtSocketState) => {
    socketState.set(socket, state);
    setParticipantFromSocketState(state);
    addSocket(state.docPath, socket);

    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
      handleMessage(socket, state, data);
    });

    socket.on("close", () => {
      removeSocket(state.docPath, socket);
      socketState.delete(socket);
      removeParticipant(state.clientInstanceId);
      if (state.socketRole === "observer") {
        removeObserverHolder(state.docPath, state.writerId, state.socketId);
      } else if (state.socketRole === "editor") {
        releaseDocSession(state.docPath, state.writerId, state.socketId)
          .then((result) => finalizeSessionEnd(state, result));
      }

      // editingPresence: writer disconnected
      if (onWsEvent) {
        const docSession = lookupDocSession(state.docPath);
        const focusedPath = docSession?.presenceManager.getAll().get(state.writerId);
        onWsEvent({
          type: "presence:done",
          writer_id: state.writerId,
          writer_display_name: state.writerDisplayName,
          writer_type: state.writerType,
          doc_path: state.docPath,
          heading_path: focusedPath ?? [],
        });
      }
    });
  });

  return {
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const route = parseCrdtUrl(request.url ?? "", request.headers.host ?? "localhost");
      if (!route) {
        rejectUpgrade(wss, request, socket, head, WS_CLOSE_INVALID_URL, `invalid_url: failed to parse ${request.url}`);
        return;
      }

      const resolved = resolveWriterWithExpiry(request.headers);
      if (!resolved || resolved.writer.type === "agent") {
        rejectUpgrade(wss, request, socket, head, WS_CLOSE_AUTH_FAILED,
          `auth_failed: ${!resolved ? "no credentials" : "agents cannot use CRDT"}`);
        return;
      }
      const writer = resolved.writer;
      const tokenExp = resolved.tokenExp;

      const canRead = await checkDocPermission(writer, route.docPath, "read");
      if (!canRead) {
        rejectUpgrade(wss, request, socket, head, WS_CLOSE_AUTHORIZATION_FAILED,
          "authorization_failed: you do not have read permission for this document");
        return;
      }
      const canWrite = await checkDocPermission(writer, route.docPath, "write");

      const clientInstanceId =
        new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`)
          .searchParams
          .get("clientInstanceId") ?? crypto.randomUUID();
      const state: CrdtSocketState = {
        clientInstanceId,
        writerId: writer.id,
        writerType: writer.type,
        writerDisplayName: writer.displayName,
        docPath: route.docPath,
        socketRole: "observer",
        requestedMode: "none",
        attachmentState: "detached",
        docSessionId: getDocSessionId(route.docPath),
        editorFocusTarget: null,
        tokenExp,
        canRead,
        canWrite,
        socketId: crypto.randomUUID(),
        joined: false,
      };

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, state);
      });
    },
  };
}
