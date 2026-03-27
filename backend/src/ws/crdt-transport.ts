/**
 * CRDT transport layer — per-socket auth state and low-level send utilities.
 *
 * Owns the per-socket state map and auth checking.
 * No Y.js. No session lookups. No business logic. No per-doc socket tracking.
 * Per-doc socket tracking (docSockets) lives in crdt-coordinator.ts.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  AttachmentState,
  ClientInstanceId,
  ClientRole,
  DocSessionId,
  EditorFocusTarget,
  RequestedMode,
} from "../types/shared.js";

// ─── Per-socket state ───────────────────────────────────────────

export interface CrdtSocketState {
  clientInstanceId: ClientInstanceId;
  writerId: string;
  writerDisplayName: string;
  docPath: string;
  /** Applied server role for this socket. Updated by mode transition FSM. */
  socketRole: ClientRole;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  editorFocusTarget: EditorFocusTarget | null;
  /** Token expiry (epoch seconds). Messages after this time close the connection. */
  tokenExp: number;
  canRead: boolean;
  canWrite: boolean;
  /** UUID assigned at socket creation; never changes. Used to identify this specific
   *  socket within the per-user HolderEntry socket-id sets. */
  socketId: string;
  /** True after joinSession has been called for this socket. Used to prevent
   *  double-join in the pre-connected observer loop. */
  joined: boolean;
}

// ─── Module state ───────────────────────────────────────────────

/** Per-socket auth + routing state. */
export const socketState = new Map<WebSocket, CrdtSocketState>();

/** Send abstraction — coordinator calls this instead of socket.send() directly. */
export function sendToSocket(socket: WebSocket, data: Uint8Array): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}

// ─── Auth utilities ──────────────────────────────────────────────

/** Check if a socket's auth token has expired. Returns true if expired (closes the socket). */
export function checkTokenExpired(ws: WebSocket, state: CrdtSocketState): boolean {
  if (state.tokenExp === Infinity) return false; // single_user mode
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < state.tokenExp) return false;
  ws.close(4011, "token_expired");
  return true;
}

// ─── Upgrade rejection ───────────────────────────────────────────

export function rejectUpgrade(
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
