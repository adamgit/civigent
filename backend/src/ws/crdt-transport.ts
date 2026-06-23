/**
 * CRDT transport layer — per-socket auth state and low-level send utilities.
 *
 * Owns the per-socket state map and auth checking.
 * No Y.js. No session lookups. No business logic. No per-doc socket tracking.
 * Per-doc socket tracking (docSockets) lives in crdt-ws-coordinator.ts.
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
  WriterType,
} from "../types/shared.js";
import { WS_CLOSE_AUTH_FAILED, WS_CLOSE_REASON_MAX_LENGTH } from "./crdt-ws-frames.js";

// ─── Per-socket state ───────────────────────────────────────────

export interface CrdtSocketState {
  clientInstanceId: ClientInstanceId;
  writerId: string;
  writerType: WriterType;
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
  /** Receipt watermark (Guarantee A): count of YJS_UPDATE frames processed from
   *  this socket so far. Incremented after each update's lane command resolves;
   *  echoed back as `MSG_UPDATE_ACK` so the client can assert "all my edits up to
   *  N are received". Optional/defaulted to 0 so existing socket-state literals
   *  (incl. test fakes) need no change. */
  receivedUpdateCount?: number;
}

/**
 * The narrow socket surface the coordinator's per-doc registry actually uses:
 * liveness (`readyState`), frame send, and close. The ws `WebSocket` satisfies
 * this structurally, so typing the registry against this interface (rather than
 * the full ws type) lets test fakes implement exactly this surface with no
 * `as unknown as` casts.
 */
export interface CoordinatorSocket {
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

// ─── Module state ───────────────────────────────────────────────

/** Per-socket auth + routing state. */
export const socketState = new Map<CoordinatorSocket, CrdtSocketState>();

/** Send abstraction — coordinator calls this instead of socket.send() directly. */
export function sendToSocket(socket: CoordinatorSocket, data: Uint8Array): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(data);
  }
}

// ─── Auth utilities ──────────────────────────────────────────────

/** Check if a socket's auth token has expired. Returns true if expired (closes the socket). */
export function checkTokenExpired(ws: CoordinatorSocket, state: CrdtSocketState): boolean {
  if (state.tokenExp === Infinity) return false; // single_user mode
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < state.tokenExp) return false;
  ws.close(WS_CLOSE_AUTH_FAILED, "token_expired");
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
    ws.close(code, reason.slice(0, WS_CLOSE_REASON_MAX_LENGTH));
  });
}
