/**
 * v4 — WebSocket CRDT transport for Yjs sync (per-document).
 *
 * Provides a WebSocket endpoint at /ws/crdt/<docPath> (no heading_path param).
 * One WebSocket per document. Section focus is communicated via
 * MSG_SECTION_FOCUS messages.
 *
 * Binary protocol:
 *   0x00 SYNC_STEP_1          — State vector
 *   0x01 SYNC_STEP_2          — State diff
 *   0x02 YJS_UPDATE            — Incremental Yjs update
 *   0x03 AWARENESS             — Awareness data
 *   0x04 SESSION_FLUSHED       — Server → Client notification
 *   0x05 SECTION_FOCUS         — Client → Server heading path (segments separated by \x00)
 *   0x06 SESSION_FLUSH_STARTED — Server → Client: flush beginning
 *   0x07 ACTIVITY_PULSE        — Client → Server: human is actively editing (debounced ~2-3s)
 *   0x08 STRUCTURE_WILL_CHANGE — Server → Client: about to restructure fragments (old→new key mapping)
 *   0x09 SECTION_MUTATE        — Client → Server: replace fragment content (JSON { fragmentKey, markdown })
 *   0x0A MUTATE_RESULT         — Server → Client: response to SECTION_MUTATE (JSON { success, error? })
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
  updateActivity,
  updateEditPulse,
  markFragmentDirty,
  triggerDebouncedFlush,
  normalizeFragment,
  setFlushCallback,
  setNormalizeBroadcast,
  type DocSession,
} from "../crdt/ydoc-lifecycle.js";
import { FragmentStore } from "../crdt/fragment-store.js";
import { getHeadSha } from "../storage/git-repo.js";
import { getDataRoot } from "../storage/data-root.js";
import { flushDocSessionToDisk, commitSessionFilesToCanonical, cleanupSessionFiles } from "../storage/session-store.js";
import type { WsServerEvent } from "../types/shared.js";

// ─── Protocol constants ─────────────────────────────────────────

const MSG_SYNC_STEP_1 = 0;
const MSG_SYNC_STEP_2 = 1;
const MSG_YJS_UPDATE = 2;
const MSG_AWARENESS = 3;
const MSG_SESSION_FLUSHED = 4;
const MSG_SECTION_FOCUS = 5;
const MSG_SESSION_FLUSH_STARTED = 6;
const MSG_ACTIVITY_PULSE = 7;
const MSG_STRUCTURE_WILL_CHANGE = 8;
const MSG_SECTION_MUTATE = 9;
const MSG_MUTATE_RESULT = 10;

// ─── Per-socket state ───────────────────────────────────────────

interface CrdtSocketState {
  writerId: string;
  writerDisplayName: string;
  docPath: string;
  observer: boolean;
  /** Token expiry (epoch seconds). Messages after this time close the connection. */
  tokenExp: number;
}

// ─── Module state ───────────────────────────────────────────────

const socketState = new Map<WebSocket, CrdtSocketState>();
const docClients = new Map<string, Set<WebSocket>>();

// ─── Upgrade rejection helper ───────────────────────────────────

function rejectUpgrade(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  code: number,
  reason: string,
): void {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.close(code, reason.slice(0, 123));
  });
}

/** Check if a socket's auth token has expired. Returns true if expired (and closes the socket). */
function checkTokenExpired(ws: WebSocket, state: CrdtSocketState): boolean {
  if (state.tokenExp === Infinity) return false; // single_user mode
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < state.tokenExp) return false;
  ws.close(4011, "token_expired");
  return true;
}

// ─── Yjs sync protocol helpers ──────────────────────────────────

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  const buf = new Uint8Array(1 + sv.length);
  buf[0] = MSG_SYNC_STEP_1;
  buf.set(sv, 1);
  return buf;
}

function encodeSyncStep2(doc: Y.Doc, clientStateVector: Uint8Array): Uint8Array {
  const diff = Y.encodeStateAsUpdate(doc, clientStateVector);
  const buf = new Uint8Array(1 + diff.length);
  buf[0] = MSG_SYNC_STEP_2;
  buf.set(diff, 1);
  return buf;
}

function encodeUpdate(update: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + update.length);
  buf[0] = MSG_YJS_UPDATE;
  buf.set(update, 1);
  return buf;
}

function encodeSessionFlushStarted(): Uint8Array {
  return new Uint8Array([MSG_SESSION_FLUSH_STARTED]);
}

function encodeSessionFlushed(writtenKeys: string[], deletedKeys: string[]): Uint8Array {
  // Payload: newline-separated written keys, \x00 separator, newline-separated deleted keys.
  // If no deletions, the \x00 and deleted part are omitted.
  let text = writtenKeys.join("\n");
  if (deletedKeys.length > 0) {
    text += "\x00" + deletedKeys.join("\n");
  }
  const payload = new TextEncoder().encode(text);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_SESSION_FLUSHED;
  buf.set(payload, 1);
  return buf;
}

function encodeStructureWillChange(
  restructures: Array<{ oldKey: string; newKeys: string[] }>,
): Uint8Array {
  const json = JSON.stringify(restructures);
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_STRUCTURE_WILL_CHANGE;
  buf.set(payload, 1);
  return buf;
}

function sendMutateResult(socket: WebSocket, success: boolean, error?: string): void {
  const json = JSON.stringify(error ? { success, error } : { success });
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_MUTATE_RESULT;
  buf.set(payload, 1);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(buf);
  }
}

// ─── URL parsing ────────────────────────────────────────────────

const CRDT_PATH_PREFIX = "/ws/crdt/";
const CRDT_OBSERVE_PATH_PREFIX = "/ws/crdt-observe/";

function parseCrdtUrl(url: string, host: string): { docPath: string; observe: boolean } | null {
  const parsed = new URL(url, `http://${host}`);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith(CRDT_OBSERVE_PATH_PREFIX)) {
    const docPath = pathname.slice(CRDT_OBSERVE_PATH_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (!docPath) return null;
    return { docPath, observe: true };
  }

  if (pathname.startsWith(CRDT_PATH_PREFIX)) {
    const docPath = pathname.slice(CRDT_PATH_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (!docPath) return null;
    return { docPath, observe: false };
  }

  return null;
}

// ─── Client tracking ────────────────────────────────────────────

function addClient(docPath: string, socket: WebSocket): void {
  let clients = docClients.get(docPath);
  if (!clients) {
    clients = new Set();
    docClients.set(docPath, clients);
  }
  clients.add(socket);
}

function removeClient(docPath: string, socket: WebSocket): void {
  const clients = docClients.get(docPath);
  if (!clients) return;
  clients.delete(socket);
  if (clients.size === 0) {
    docClients.delete(docPath);
  }
}

function broadcastToOthers(docPath: string, sender: WebSocket, data: Uint8Array): void {
  const clients = docClients.get(docPath);
  if (!clients) return;
  for (const client of clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function broadcastToAll(docPath: string, data: Uint8Array): void {
  const clients = docClients.get(docPath);
  if (!clients) return;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Message handler ────────────────────────────────────────────

function handleMessage(
  socket: WebSocket,
  doc: Y.Doc,
  state: CrdtSocketState,
  data: Buffer,
): void {
  if (data.length < 1) return;

  const msgType = data[0];
  const payload = data.subarray(1);

  // Observer sockets: only allow sync protocol (SYNC_STEP_1/2).
  // Ignore YJS_UPDATE, SECTION_FOCUS, ACTIVITY_PULSE, SECTION_MUTATE — no-op, don't apply to Y.Doc.
  if (state.observer) {
    if (msgType === MSG_YJS_UPDATE || msgType === MSG_SECTION_FOCUS || msgType === MSG_ACTIVITY_PULSE || msgType === MSG_SECTION_MUTATE) {
      return;
    }
  }

  switch (msgType) {
    case MSG_SYNC_STEP_1: {
      const response = encodeSyncStep2(doc, payload);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(response);
      }
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
      // Use the writer's current section focus to resolve to a stable fragment key.
      // If no focus has been sent yet, use the afterTransaction listener's
      // lastTouchedFragments set to mark only actually-modified fragments.
      const session = lookupDocSession(state.docPath);
      if (session) {
        const focusedPath = session.sectionFocus.get(state.writerId);
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
          // No focus set yet — mark only the fragments actually touched by
          // this Y.Doc transaction, avoiding the O(N) mark-all-dirty cascade.
          for (const fragmentKey of session.lastTouchedFragments) {
            session.fragments.markDirty(fragmentKey);
            markFragmentDirty(state.docPath, state.writerId, fragmentKey);
          }
          session.lastTouchedFragments.clear();
        }

        // Trigger debounced flush — fires 1s after the last Y.Doc change
        triggerDebouncedFlush(state.docPath);
      }
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
      // Payload = heading path segments separated by \x00
      const headingPath = new TextDecoder()
        .decode(payload)
        .split("\x00")
        .filter(Boolean);

      const { oldFocus } = updateSectionFocus(state.docPath, state.writerId, headingPath);

      // Normalize the LEFT (old) fragment on focus change
      if (oldFocus) {
        const session = lookupDocSession(state.docPath);
        if (session) {
          // resolveByHeadingPath returns null if heading was renamed/restructured — non-fatal
          const oldEntry = session.fragments.skeleton.resolveByHeadingPath(oldFocus);
          if (oldEntry) {
            const oldKey = FragmentStore.fragmentKeyFor(oldEntry);
            normalizeFragment(state.docPath, oldKey).catch((err) => {
              // Fire-and-forget normalization. Rethrow as unhandled so the process error
              // handler surfaces it. Fragment stays unnormalized until disconnect (normalizeAllFragments).
              throw err instanceof Error ? err : new Error(String(err));
            });
          }
        }
      }

      // Broadcast editingPresence events (server-authoritative, drives agent blocking)
      if (onWsEvent) {
        if (oldFocus) {
          onWsEvent({
            type: "presence:done",  // editingPresence: human left this section
            writer_id: state.writerId,
            doc_path: state.docPath,
            heading_path: oldFocus,
          });
        }
        onWsEvent({
          type: "presence:editing",  // editingPresence: human now editing this section
          doc_path: state.docPath,
          writer_id: state.writerId,
          writer_display_name: state.writerDisplayName,
          heading_path: headingPath,
        });
      }
      break;
    }
    case MSG_ACTIVITY_PULSE: {
      // Human is actively editing — record the pulse timestamp.
      // This is the only signal that resets the idle timeout.
      updateEditPulse(state.docPath, state.writerId);
      break;
    }
    case MSG_SECTION_MUTATE: {
      // Client requests a section content mutation (cross-section drag/drop).
      // Payload: JSON { fragmentKey: string, markdown: string }
      const json = new TextDecoder().decode(payload);
      let parsed: { fragmentKey: string; markdown: string };
      try {
        parsed = JSON.parse(json);
      } catch {
        sendMutateResult(socket, false, "Invalid JSON payload");
        break;
      }

      const session = lookupDocSession(state.docPath);
      if (!session) {
        sendMutateResult(socket, false, "No active session");
        break;
      }

      // Verify fragment key exists in skeleton
      const entry = session.fragments.resolveEntryForKey(parsed.fragmentKey);
      if (!entry) {
        sendMutateResult(socket, false, `Fragment key not found: ${parsed.fragmentKey}`);
        break;
      }

      // Snapshot state vector before mutation for computing incremental update
      const svBefore = Y.encodeStateVector(doc);

      // Apply the mutation: populate fragment with new content
      session.fragments.populateFragment(parsed.fragmentKey, parsed.markdown);

      // Mark dirty for flush and per-user attribution
      session.fragments.markDirty(parsed.fragmentKey);
      markFragmentDirty(state.docPath, state.writerId, parsed.fragmentKey);

      // Broadcast the Y.Doc update to other clients
      const update = Y.encodeStateAsUpdate(doc, svBefore);
      if (update.length > 0) {
        broadcastToOthers(state.docPath, socket, encodeUpdate(update));
      }

      // Trigger debounced flush
      triggerDebouncedFlush(state.docPath);

      sendMutateResult(socket, true);
      break;
    }
  }
}

// ─── Flush-to-session callback ──────────────────────────────────

async function flushToSession(session: DocSession): Promise<void> {
  // Notify clients that a flush is starting (only if there's dirty data).
  // Check dirty set before flush to decide whether to send FLUSH_STARTED.
  const hasDirtyFragments = session.fragments.dirtyKeys.size > 0;

  if (hasDirtyFragments) {
    broadcastToAll(session.docPath, encodeSessionFlushStarted());
  }

  const { writtenKeys, deletedKeys } = await flushDocSessionToDisk(session);

  // Only send SESSION_FLUSHED if something was actually written or deleted.
  // No-op flushes produce no messages — the client's state is unchanged.
  if (writtenKeys.length > 0 || deletedKeys.length > 0) {
    broadcastToAll(session.docPath, encodeSessionFlushed(writtenKeys, deletedKeys));

    if (onWsEvent) {
      onWsEvent({
        type: "session:flushed",
        doc_path: session.docPath,
      });
    }
  }
}

// Register the flush callback
setFlushCallback(flushToSession);

// Register normalization broadcast callback
setNormalizeBroadcast((docPath: string, info: Array<{ oldKey: string; newKeys: string[] }>) => {
  broadcastToAll(docPath, encodeStructureWillChange(info));
  if (onWsEvent) {
    onWsEvent({
      type: "doc:structure-changed",
      doc_path: docPath,
    });
  }
});

// ─── Idle timeout → disconnect all clients for a doc ─────────────

import { setIdleTimeoutHandler } from "../crdt/ydoc-lifecycle.js";

setIdleTimeoutHandler((docPath: string) => {
  const clients = docClients.get(docPath);
  if (!clients) return;
  // Close all WebSocket connections for this document.
  // Each close triggers the socket "close" handler which calls
  // releaseDocSession → commitSessionFilesToCanonical (for editors)
  // or just removeClient + delete socketState (for observers).
  // Copy to array before iterating — close handlers mutate the Set
  for (const client of [...clients]) {
    if (client.readyState === WebSocket.OPEN) {
      const st = socketState.get(client);
      if (st?.observer) {
        client.close(4021, "session_ended");
      } else {
        client.close(4020, "idle_timeout");
      }
    }
  }
});

// ─── Event handler ──────────────────────────────────────────────

let onWsEvent: ((event: WsServerEvent) => void) | null = null;

export function setCrdtEventHandler(handler: (event: WsServerEvent) => void): void {
  onWsEvent = handler;
}

// ─── Public API ─────────────────────────────────────────────────

// ─── Observer notification helpers ───────────────────────────────

/** Send sync step 1 to all observer sockets for a doc path (bootstraps their Y.Doc). */
function syncObserversForDoc(docPath: string, ydoc: Y.Doc): void {
  const clients = docClients.get(docPath);
  if (!clients) return;
  const msg = encodeSyncStep1(ydoc);
  for (const client of clients) {
    const st = socketState.get(client);
    if (st?.observer && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

/** Close all observer sockets for a doc path with a specific close code. */
function closeObserversForDoc(docPath: string, code: number, reason: string): void {
  const clients = docClients.get(docPath);
  if (!clients) return;
  for (const client of [...clients]) {
    const st = socketState.get(client);
    if (st?.observer && client.readyState === WebSocket.OPEN) {
      client.close(code, reason.slice(0, 123));
    }
  }
}

export interface CrdtWsServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export function createCrdtWsServer(): CrdtWsServer {
  const wss = new WebSocketServer({ noServer: true });
  const observerWss = new WebSocketServer({ noServer: true });

  // ─── Editor connection handler ──────────────────────────────
  wss.on("connection", (socket: WebSocket, session: DocSession, state: CrdtSocketState) => {
    socketState.set(socket, state);
    addClient(state.docPath, socket);

    // If this is the first holder (new session), notify any pre-connected observers
    if (session.holders.size === 1) {
      syncObserversForDoc(state.docPath, session.fragments.ydoc);
    }

    // Send sync step 1 so client can respond with its state
    const syncStep1 = encodeSyncStep1(session.fragments.ydoc);
    socket.send(syncStep1);

    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
      handleMessage(socket, session.fragments.ydoc, state, data);
    });

    socket.on("close", () => {
      removeClient(state.docPath, socket);
      socketState.delete(socket);

      // Release holder — if this was the last holder, trigger departure commit
      releaseDocSession(state.docPath, state.writerId)
        .then(async (result) => {
          if (result.sessionEnded) {
            // Y.Doc destroyed, data flushed to disk — commit session files immediately
            const writer = { id: state.writerId, type: "human" as const, displayName: state.writerDisplayName };
            const commitResult = await commitSessionFilesToCanonical(writer, state.docPath);
            if (commitResult.skeletonErrors.length > 0) {
              // Corrupt overlay skeleton — session files preserved on disk for manual recovery.
              // Do NOT clean up session files — they may be the only copy.
              // Next attempt to open this doc for editing will throw (skeleton corruption
              // surfaced by DocumentSkeleton.fromDisk), preventing further damage.
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
                  writer_id: state.writerId,
                  writer_display_name: state.writerDisplayName,
                });

                for (const section of commitResult.committedSections) {
                  onWsEvent({
                    type: "dirty:changed",
                    writer_id: state.writerId,
                    doc_path: section.doc_path,
                    heading_path: section.heading_path,
                    dirty: false,
                    base_head: null,
                    committed_head: commitResult.commitSha,
                  });
                }
              }
            }

            // Session ended — notify observer sockets
            closeObserversForDoc(state.docPath, 4021, "session_ended");
          }
        })
        .catch((err) => {
          // Re-throw as unhandled rejection so it surfaces in logs
          throw err;
        });

      // editingPresence: human disconnected — no longer editing
      if (onWsEvent) {
        const docSession = lookupDocSession(state.docPath);
        const focusedPath = docSession?.sectionFocus.get(state.writerId);
        onWsEvent({
          type: "presence:done",  // editingPresence: writer disconnected
          writer_id: state.writerId,
          doc_path: state.docPath,
          heading_path: focusedPath ?? [],
        });
      }
    });
  });

  // ─── Observer connection handler ────────────────────────────
  observerWss.on("connection", (socket: WebSocket, state: CrdtSocketState) => {
    socketState.set(socket, state);
    addClient(state.docPath, socket);

    // If an editing session already exists, send initial sync
    const session = lookupDocSession(state.docPath);
    if (session) {
      const syncStep1 = encodeSyncStep1(session.fragments.ydoc);
      socket.send(syncStep1);
    }
    // If no session exists, observer waits — sync will be sent when an editor connects

    socket.on("message", (raw) => {
      if (checkTokenExpired(socket, state)) return;
      // Observer can still send SYNC_STEP_1/2 for initial sync handshake
      const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
      const session = lookupDocSession(state.docPath);
      if (session) {
        handleMessage(socket, session.fragments.ydoc, state, data);
      }
    });

    socket.on("close", () => {
      // Observer disconnect: just clean up — no session release, no commit
      removeClient(state.docPath, socket);
      socketState.delete(socket);
    });
  });

  return {
    async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      // 1. Parse URL
      const route = parseCrdtUrl(request.url ?? "", request.headers.host ?? "localhost");
      if (!route) {
        rejectUpgrade(wss, request, socket, head, 4010, `invalid_url: failed to parse ${request.url}`);
        return;
      }

      // 2. Auth — only humans can use CRDT (editing or observing)
      const resolved = resolveWriterWithExpiry(request.headers);
      if (!resolved || resolved.writer.type === "agent") {
        rejectUpgrade(wss, request, socket, head, 4011,
          `auth_failed: ${!resolved ? "no credentials" : "agents cannot use CRDT"}`);
        return;
      }
      const writer = resolved.writer;
      const tokenExp = resolved.tokenExp;

      // 2b. Document-level authorization — check ACL
      // Observers need read permission; editors need write permission.
      const wsAction = route.observe ? "read" : "write";
      const docAllowed = await checkDocPermission(writer, route.docPath, wsAction);
      if (!docAllowed) {
        rejectUpgrade(wss, request, socket, head, 4013,
          `authorization_failed: you do not have ${wsAction} permission for this document`);
        return;
      }

      // ─── Observer upgrade path ────────────────────────────────
      if (route.observe) {
        const state: CrdtSocketState = {
          writerId: writer.id,
          writerDisplayName: writer.displayName,
          docPath: route.docPath,
          observer: true,
          tokenExp,
        };

        observerWss.handleUpgrade(request, socket, head, (ws) => {
          observerWss.emit("connection", ws, state);
        });
        return;
      }

      // ─── Editor upgrade path ──────────────────────────────────
      // 3. Acquire or join DocSession
      let session: DocSession;
      try {
        const baseHead = await getHeadSha(getDataRoot());
        session = await acquireDocSession(route.docPath, writer.id, baseHead, writer);
      } catch (err) {
        rejectUpgrade(wss, request, socket, head, 4014,
          `ydoc_init_failed: ${(err as Error).message}`);
        return;
      }

      const state: CrdtSocketState = {
        writerId: writer.id,
        writerDisplayName: writer.displayName,
        docPath: route.docPath,
        observer: false,
        tokenExp,
      };

      // 4. editingPresence: human connected to document (doc-level, no specific section yet)
      if (onWsEvent) {
        onWsEvent({
          type: "presence:editing",  // editingPresence: writer connected
          doc_path: route.docPath,
          writer_id: writer.id,
          writer_display_name: writer.displayName,
          heading_path: [],
        });
      }

      // 5. Accept upgrade
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, session, state);
      });
    },
  };
}
