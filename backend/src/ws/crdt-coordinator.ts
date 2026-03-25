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
import {
  MSG_SYNC_STEP_1,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_SECTION_FOCUS,
  MSG_ACTIVITY_PULSE,
  MSG_SECTION_MUTATE,
  encodeSyncStep2,
  encodeUpdate,
  encodeSessionFlushStarted,
  encodeSessionFlushed,
  encodeStructureWillChange,
  encodeMutateResult,
  encodeRestoreNotification,
  decodeMessage,
  parseCrdtUrl,
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
      socket.close(4022, "document restored");
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

function handleMessage(
  socket: WebSocket,
  doc: Y.Doc,
  state: CrdtSocketState,
  session: DocSession,
  data: Buffer,
): void {
  const decoded = decodeMessage(data);
  if (!decoded) return;

  const { type: msgType, payload } = decoded;

  // Block write operations from observers (role is anchored in CrdtSocketState.socketRole).
  if (state.socketRole === "observer") {
    if (msgType === MSG_YJS_UPDATE || msgType === MSG_SECTION_FOCUS || msgType === MSG_ACTIVITY_PULSE || msgType === MSG_SECTION_MUTATE) {
      return;
    }
  }

  switch (msgType) {
    case MSG_SYNC_STEP_1: {
      const response = encodeSyncStep2(doc, payload);
      sendToSocket(socket, response);
      break;
    }
    case MSG_SYNC_STEP_2: {
      Y.applyUpdate(doc, payload);
      break;
    }
    case MSG_YJS_UPDATE: {
      Y.applyUpdate(doc, payload);
      broadcastToOthers(state.docPath, socket, encodeUpdate(payload));
      updateActivity(state.docPath);

      // Track which fragment this writer dirtied (for author metadata).
      const focusedPath = session.presenceManager.getAll().get(state.writerId);
      if (focusedPath) {
        try {
          const entry = session.fragments.skeleton.resolve(focusedPath);
          const fragmentKey = FragmentStore.fragmentKeyFor(entry);
          session.fragments.markDirty(fragmentKey);
          const isNewlyDirty = markFragmentDirty(state.docPath, state.writerId, fragmentKey);
          if (isNewlyDirty && onWsEvent) {
            onWsEvent({
              type: "dirty:changed",
              writer_id: state.writerId,
              doc_path: state.docPath,
              heading_path: focusedPath,
              dirty: true,
              base_head: session.baseHead,
            });
          }
        } catch {
          // Skeleton resolve can fail during structural changes — skip dirty tracking
        }
      } else {
        // No focus set yet — mark only the fragments actually touched by this transaction
        for (const fragmentKey of session.lastTouchedFragments) {
          session.fragments.markDirty(fragmentKey);
          markFragmentDirty(state.docPath, state.writerId, fragmentKey);
        }
        session.lastTouchedFragments.clear();
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

      const { oldFocus } = updateSectionFocus(state.docPath, state.writerId, headingPath);

      // Normalize the LEFT (old) fragment on focus change
      if (oldFocus) {
        let oldEntry = null;
        try { oldEntry = session.fragments.skeleton.resolve(oldFocus); } catch (e) {
          if (!(e instanceof Error) || !e.message.startsWith("Skeleton integrity error")) throw e;
        }
        if (oldEntry) {
          const oldKey = FragmentStore.fragmentKeyFor(oldEntry);
          normalizeFragment(state.docPath, oldKey).catch((err) => {
            throw err instanceof Error ? err : new Error(String(err));
          });
        }
      }

      // Broadcast editingPresence events
      if (onWsEvent) {
        if (oldFocus) {
          onWsEvent({
            type: "presence:done",
            writer_id: state.writerId,
            writer_display_name: state.writerDisplayName,
            writer_type: "human",
            doc_path: state.docPath,
            heading_path: oldFocus,
          });
        }
        onWsEvent({
          type: "presence:editing",
          doc_path: state.docPath,
          writer_id: state.writerId,
          writer_display_name: state.writerDisplayName,
          writer_type: "human",
          heading_path: headingPath,
        });
      }
      break;
    }
    case MSG_ACTIVITY_PULSE: {
      updateEditPulse(state.docPath, state.writerId);
      // Accumulate contributor for commit attribution (the unambiguous "actively editing" signal).
      addContributor(state.docPath, state.writerId, {
        id: state.writerId,
        type: "human" as const,
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

      const entry = session.fragments.resolveEntryForKey(parsed.fragmentKey);
      if (!entry) {
        sendToSocket(socket, encodeMutateResult(false, `Fragment key not found: ${parsed.fragmentKey}`));
        break;
      }

      const svBefore = Y.encodeStateVector(doc);
      session.fragments.populateFragment(parsed.fragmentKey, parsed.markdown);
      session.fragments.markDirty(parsed.fragmentKey);
      markFragmentDirty(state.docPath, state.writerId, parsed.fragmentKey);

      const update = Y.encodeStateAsUpdate(doc, svBefore);
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
        client.close(4021, "session_ended");
      } else {
        client.close(4020, "idle_timeout");
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
      client.close(code, reason.slice(0, 123));
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

export interface CrdtWsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createCrdtWsServer(): CrdtWsServer {
  const wss = new WebSocketServer({ noServer: true });

  // ─── Unified connection handler (editors + observers) ───────
  wss.on("connection", (socket: WebSocket, role: "editor" | "observer", editorSession: DocSession | null, state: CrdtSocketState) => {
    socketState.set(socket, state);
    addSocket(state.docPath, socket);

    // Resolve the active session. For editors it's the just-acquired session;
    // for observers it may or may not exist (observer can pre-connect).
    const session = role === "editor" ? editorSession! : lookupDocSession(state.docPath);

    if (session) {
      if (role === "observer") {
        // Observer connected while a session is active — add to holders.
        addObserverHolder(session, state.writerId, {
          id: state.writerId,
          type: "human" as const,
          displayName: state.writerDisplayName,
        }, state.socketId);
      } else {
        // First editor in the session: join any pre-connected observers that aren't yet holders.
        if (countEditorSockets(session) === 1) {
          for (const client of docSockets.get(state.docPath) ?? []) {
            if (client === socket) continue;
            const st = socketState.get(client);
            // Use joined flag and socketRole — not holders.has() — to detect pre-connected observers.
            if (st && !st.joined && st.socketRole === "observer" && client.readyState === WebSocket.OPEN) {
              addObserverHolder(session, st.writerId, {
                id: st.writerId,
                type: "human" as const,
                displayName: st.writerDisplayName,
              }, st.socketId);
              joinSession(session, (msg) => client.send(msg), (event) => { if (onWsEvent) onWsEvent(event); });
              st.joined = true;
              const obsNotification = getPendingRestoreNotification(state.docPath, st.writerId);
              if (obsNotification) {
                sendToSocket(client, encodeRestoreNotification(obsNotification));
              }
            }
          }
        }
      }
      // Atomic sync + presence replay for the joining participant.
      joinSession(session, (msg) => socket.send(msg), (event) => { if (onWsEvent) onWsEvent(event); });
      state.joined = true;

      // Send pending restore notification (if any) immediately after join.
      // Ordering: notification arrives before SYNC_STEP_2 content — client stores it,
      // fires the banner only after onSynced (content visible).
      const notification = getPendingRestoreNotification(state.docPath, state.writerId);
      if (notification) {
        sendToSocket(socket, encodeRestoreNotification(notification));
      }
    }

    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
      const activeSession = lookupDocSession(state.docPath);
      if (!activeSession) return;
      handleMessage(socket, activeSession.fragments.ydoc, state, activeSession, data);
    });

    socket.on("close", () => {
      removeSocket(state.docPath, socket);
      socketState.delete(socket);

      // Use the socket's creation-time role, not the user's current holder role.
      // This prevents a race where an observer socket close fires after the editor
      // socket has already promoted the user to "editor" in session.holders.
      if (state.socketRole === "observer") {
        removeObserverHolder(state.docPath, state.writerId, state.socketId);
        return;
      }

      // Editor (or unknown — session may have already ended).
      releaseDocSession(state.docPath, state.writerId, state.socketId)
        .then(async (result) => {
          if (result.sessionEnded) {
            // Build contributors list: the disconnecting editor is primary; others from session.
            const primaryWriter: WriterIdentity = {
              id: state.writerId,
              type: "human" as const,
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
                  source: "human_auto_commit",
                  writer_id: contributors[0].id,
                  writer_display_name: contributors[0].displayName,
                  writer_type: "human",
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
        })
        .catch((err) => { throw err; });

      // editingPresence: writer disconnected
      if (onWsEvent) {
        const docSession = lookupDocSession(state.docPath);
        const focusedPath = docSession?.presenceManager.getAll().get(state.writerId);
        onWsEvent({
          type: "presence:done",
          writer_id: state.writerId,
          writer_display_name: state.writerDisplayName,
          writer_type: "human",
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
        rejectUpgrade(wss, request, socket, head, 4010, `invalid_url: failed to parse ${request.url}`);
        return;
      }

      const resolved = resolveWriterWithExpiry(request.headers);
      if (!resolved || resolved.writer.type === "agent") {
        rejectUpgrade(wss, request, socket, head, 4011,
          `auth_failed: ${!resolved ? "no credentials" : "agents cannot use CRDT"}`);
        return;
      }
      const writer = resolved.writer;
      const tokenExp = resolved.tokenExp;

      const wsAction = route.observe ? "read" : "write";
      const docAllowed = await checkDocPermission(writer, route.docPath, wsAction);
      if (!docAllowed) {
        rejectUpgrade(wss, request, socket, head, 4013,
          `authorization_failed: you do not have ${wsAction} permission for this document`);
        return;
      }

      if (route.observe) {
        const observerState: CrdtSocketState = {
          writerId: writer.id,
          writerDisplayName: writer.displayName,
          docPath: route.docPath,
          socketRole: "observer",
          tokenExp,
          socketId: crypto.randomUUID(),
          joined: false,
        };
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, "observer", null, observerState);
        });
        return;
      }

      const state: CrdtSocketState = {
        writerId: writer.id,
        writerDisplayName: writer.displayName,
        docPath: route.docPath,
        socketRole: "editor",
        tokenExp,
        socketId: crypto.randomUUID(),
        joined: false,
      };

      // Enforce single editor socket per user per document.
      // Close any existing editor socket for this user so PresenceManager stays unambiguous.
      for (const existingSocket of docSockets.get(route.docPath) ?? []) {
        const st = socketState.get(existingSocket);
        if (st?.writerId === writer.id && st?.socketRole === "editor" && existingSocket.readyState === WebSocket.OPEN) {
          existingSocket.close(4023, "superseded_by_new_tab");
        }
      }

      let session: DocSession;
      try {
        const baseHead = await getHeadSha(getDataRoot());
        session = await acquireDocSession(route.docPath, writer.id, baseHead, writer, state.socketId);
      } catch (err) {
        rejectUpgrade(wss, request, socket, head, 4014,
          `ydoc_init_failed: ${(err as Error).message}`);
        return;
      }

      if (onWsEvent) {
        onWsEvent({
          type: "presence:editing",
          doc_path: route.docPath,
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          writer_type: "human",
          heading_path: [],
        });
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, "editor", session, state);
      });
    },
  };
}
