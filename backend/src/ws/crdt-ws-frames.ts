/**
 * CRDT binary WebSocket frame codec — message type constants, encode, decode.
 *
 * Pure functions only. No session state, no network I/O.
 * All encode helpers return a Uint8Array ready to send over any transport.
 *
 * This is the binary CRDT *editor channel* frame codec. The legacy
 * session-overlay / focus / pulse / mutate / receipt / idle-timeout protocol
 * items have been removed (spec 05 §4 WebSocket Protocol > Removed message
 * types). The DocSession publish-pause control messages ride this same ordered
 * editor channel as Yjs updates (spec 05 §4 > DocSession publish pause
 * messages): processing a `doc_publish_ready` ack proves that earlier Yjs
 * updates from the same socket have already reached the DocSession actor.
 *
 * Section block-state events (`section:blocked`/`unblocked`/`gone`) travel on
 * the JSON application WebSocket as server events, NOT as binary frames here
 * (spec 05 §4 calls them "events"; 06-mirror-and-signals §7 describes JSON-WS
 * pushes). See assumptions.md "Area H decisions".
 *
 * Backend authority: the DocSession Y.Doc is the sole source of truth for
 * document content. Clients bootstrap FROM the backend via server→client
 * SYNC_STEP_2 and mutate the DocSession ONLY through MSG_YJS_UPDATE, which
 * enters the DocSession actor lane via `processArbitratedClientUpdate(...)`
 * (acceptance gate + proposal materialization + broadcast). Client→server
 * SYNC_STEP_2 replies are IGNORED as document mutations by design — offline
 * client document content is not supported in this architecture, so allowing
 * the sync reply to apply as `Y.applyUpdate(doc, payload)` on the server would
 * bypass the acceptance gate and let stale client state overwrite the
 * authoritative Y.Doc. See `crdt-ws-coordinator.ts` MSG_SYNC_STEP_2 handler.
 *
 * Binary protocol:
 *   0x00 SYNC_STEP_1                — State vector (client→server and server→client)
 *   0x01 SYNC_STEP_2                — State diff: server→client bootstraps client
 *                                     state; client→server is IGNORED (no writes
 *                                     via sync protocol; use YJS_UPDATE instead)
 *   0x02 YJS_UPDATE                 — Incremental Yjs update; the ONLY client→server
 *                                     document mutation path
 *   0x03 AWARENESS                  — Awareness data
 *   0x0B DOCUMENT_REPLACEMENT_NOTICE — Server → Client: reconnect notice after restore/overwrite
 *   0x0C MODE_TRANSITION_REQUEST    — Client → Server: request mode transition (JSON ModeTransitionRequest)
 *   0x0D MODE_TRANSITION_RESULT     — Server → Client: transition ack/reject (JSON ModeTransitionResult)
 *   0x10 DOC_PUBLISH_PAUSE_START    — Server → Client: DocSession publish pause begun; freeze editors
 *   0x11 DOC_PUBLISH_READY          — Client → Server: editors frozen / no more Yjs txns (ordered ack)
 *   0x12 DOC_PUBLISH_PAUSE_END      — Server → Client: publish attempt ended; editors may unfreeze
 *
 * Opcode 0x08 (legacy STRUCTURE_WILL_CHANGE) is permanently reserved-removed
 * and MUST NEVER be defined here: the new design does not expose live
 * fragment-key remaps as a client contract.
 *
 * The SYNC_STEP byte values are also duplicated in `crdt/ydoc-lifecycle.ts`
 * (joinSession) and MUST match the constants below.
 *
 * Close codes (application-level, above 4000):
 *   4001 — auth_required
 *   4010 — invalid_url
 *   4011 — auth_failed / token_expired
 *   4013 — authorization_failed
 *   4014 — ydoc_init_failed
 *   4021 — session_ended: last editor disconnected; observers fall back to REST and reconnect
 *   4022 — document_replaced: restore/overwrite invalidated session; all clients reconnect immediately (no backoff)
 *   4023 — superseded_by_new_tab: same user opened a new editor tab for this document
 *   4024 — admin_rebuild: admin force-rebuild invalidated the live Y.Doc; clients reconnect immediately and reseed
 *   4025 — system_lockdown: admin-triggered backup or restore fenced off live sockets; reconnect once readiness returns
 *
 * (4020 idle_timeout is REMOVED — there is no idle timer in this architecture.)
 */

import * as Y from "yjs";
import type {
  DocumentReplacementNoticePayload,
  EditorFocusTarget,
  JsonObject,
  JsonValue,
  ModeTransitionRequest,
  ModeTransitionResult,
  RequestedMode,
} from "../types/shared.js";
import { expectJsonObject } from "../types/shared.js";

// ─── Message type constants ──────────────────────────────────────

export const MSG_SYNC_STEP_1 = 0;
export const MSG_SYNC_STEP_2 = 1;
export const MSG_YJS_UPDATE = 2;
export const MSG_AWARENESS = 3;
/**
 * Server → client receipt watermark (Guarantee A). After the server has applied
 * + arbitrated a client `MSG_YJS_UPDATE` through the DocSession actor lane, it
 * emits this frame carrying a monotonically increasing count of YJS_UPDATE
 * frames processed FROM that socket. Because the per-socket message chain is
 * FIFO and each update's lane command is awaited before the next frame is read,
 * a single scalar count is a true watermark: "every update you sent up to count
 * N is received and applied to the authoritative Y.Doc". The client counts its
 * own sent updates independently; the two counters stay aligned by FIFO order,
 * so NO sequence number rides the `MSG_YJS_UPDATE` frame (format unchanged).
 */
export const MSG_UPDATE_ACK = 4;
export const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0B;
export const MSG_MODE_TRANSITION_REQUEST = 0x0C;
export const MSG_MODE_TRANSITION_RESULT = 0x0D;

// ─── DocSession publish-pause control messages ───────────────────
// These ride the same ordered editor channel as Yjs updates (spec 05 §4
// > DocSession publish pause messages). Opcodes chosen in the freed high
// range so they are unambiguous against the removed legacy opcodes; 0x08 is
// never reused.

export const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
export const MSG_DOC_PUBLISH_READY = 0x11;
export const MSG_DOC_PUBLISH_PAUSE_END = 0x12;

// ─── Cross-section move — REMOVED from the binary protocol ───────
// Opcode 0x13 is RESERVED/UNUSED (do not reassign). The live cross-section move
// was moved off the CRDT binary channel onto a REST control-plane endpoint
// (`POST /workspace/:docPath/live-move` → `requestDocSessionMove(...)`), because
// it is a refusable CONTROL operation (request/response + prose refusal), not
// content propagation where "the YJS_UPDATE delta is the broadcast"
// (claim-review 03 / Option E). 0x08 also stays permanently reserved-removed.

// ─── WebSocket close codes ───────────────────────────────────────

export const WS_CLOSE_AUTH_REQUIRED = 4001;
export const WS_CLOSE_INVALID_URL = 4010;
export const WS_CLOSE_AUTH_FAILED = 4011;
export const WS_CLOSE_AUTHORIZATION_FAILED = 4013;
export const WS_CLOSE_YDOC_INIT_FAILED = 4014;
export const WS_CLOSE_SESSION_ENDED = 4021;
export const WS_CLOSE_DOCUMENT_REPLACED = 4022;
export const WS_CLOSE_SUPERSEDED = 4023;
/** Admin force-rebuild invalidation. Distinct from 4022 (restore) and session-end codes. */
export const WS_CLOSE_ADMIN_REBUILD = 4024;
/**
 * Admin-triggered whole-instance lockdown for backup or restore. Every live
 * CRDT socket is closed with this code and reason `system_lockdown`; the
 * frontend treats it as a system-starting condition and reconnects through
 * the readiness/backoff path once the readiness gate opens again.
 */
export const WS_CLOSE_SYSTEM_LOCKDOWN = 4025;
export const WS_CLOSE_REASON_MAX_LENGTH = 123;

// ─── URL routing constants ────────────────────────────────────────

export const CRDT_PATH_PREFIX = "/ws/crdt/";

// ─── Encode helpers ──────────────────────────────────────────────

export function encodeSyncStep2(doc: Y.Doc, clientStateVector: Uint8Array): Uint8Array {
  const diff = Y.encodeStateAsUpdate(doc, clientStateVector);
  const buf = new Uint8Array(1 + diff.length);
  buf[0] = MSG_SYNC_STEP_2;
  buf.set(diff, 1);
  return buf;
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + update.length);
  buf[0] = MSG_YJS_UPDATE;
  buf.set(update, 1);
  return buf;
}

/**
 * Encode a receipt-watermark ack (Guarantee A): `[MSG_UPDATE_ACK][count:uint32 BE]`.
 * `count` is the number of YJS_UPDATE frames processed from the target socket so
 * far. Sent to the originating socket only, after the update's lane command has
 * resolved (i.e. the update is materialized into the authoritative Y.Doc).
 */
export function encodeUpdateAck(count: number): Uint8Array {
  const buf = new Uint8Array(5);
  buf[0] = MSG_UPDATE_ACK;
  // uint32 big-endian; wraps at 2^32 (≈4.3B updates per session — unreachable).
  buf[1] = (count >>> 24) & 0xff;
  buf[2] = (count >>> 16) & 0xff;
  buf[3] = (count >>> 8) & 0xff;
  buf[4] = count & 0xff;
  return buf;
}

export function encodeDocumentReplacementNotice(payload: DocumentReplacementNoticePayload): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_DOCUMENT_REPLACEMENT_NOTICE;
  msg.set(json, 1);
  return msg;
}

export function encodeModeTransitionRequest(payload: ModeTransitionRequest): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_MODE_TRANSITION_REQUEST;
  msg.set(json, 1);
  return msg;
}

// ─── Mode-transition decode (JSON trust boundary) ────────────────
//
// Colocated with encodeModeTransitionRequest so encode/decode for the frame are
// one auditable boundary. Every invalid field throws an `Error` naming the field
// and the offending value — no `as`, no `null`-return, no catch-and-substitute.

function requireStringField(obj: JsonObject, key: string, label: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function decodeRequestedMode(value: JsonValue, label: string): RequestedMode {
  if (value === "none" || value === "observer" || value === "editor") return value;
  throw new Error(`${label} must be "none" | "observer" | "editor", got ${JSON.stringify(value)}`);
}

function decodeEditorFocusTargetOrNull(value: JsonValue, label: string): EditorFocusTarget | null {
  if (value === null) return null;
  const obj = expectJsonObject(value, label);
  const kind = obj["kind"];
  if (kind === "before_first_heading") {
    return { kind: "before_first_heading" };
  }
  if (kind === "heading_path") {
    const rawPath = obj["heading_path"];
    if (!Array.isArray(rawPath)) {
      throw new Error(`${label}.heading_path must be an array, got ${JSON.stringify(rawPath)}`);
    }
    const heading_path = rawPath.map((element, index) => {
      if (typeof element !== "string") {
        throw new Error(`${label}.heading_path[${index}] must be a string, got ${JSON.stringify(element)}`);
      }
      return element;
    });
    return { kind: "heading_path", heading_path };
  }
  throw new Error(`${label}.kind must be "before_first_heading" | "heading_path", got ${JSON.stringify(kind)}`);
}

/**
 * Decode a `MSG_MODE_TRANSITION_REQUEST` payload from the wire. Throws (with the
 * offending field) on any malformed input — the `editorFocusTarget` union is
 * validated here rather than flowing unchecked from wire to `state`.
 */
export function decodeModeTransitionRequest(value: JsonValue): ModeTransitionRequest {
  const label = "ModeTransitionRequest";
  const obj = expectJsonObject(value, label);
  return {
    requestId: requireStringField(obj, "requestId", label),
    clientInstanceId: requireStringField(obj, "clientInstanceId", label),
    docPath: requireStringField(obj, "docPath", label),
    requestedMode: decodeRequestedMode(obj["requestedMode"], `${label}.requestedMode`),
    editorFocusTarget: decodeEditorFocusTargetOrNull(obj["editorFocusTarget"], `${label}.editorFocusTarget`),
  };
}

export function encodeModeTransitionResult(payload: ModeTransitionResult): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_MODE_TRANSITION_RESULT;
  msg.set(json, 1);
  return msg;
}

// ─── DocSession publish-pause encoders ───────────────────────────

/** Server → client: the DocSession actor has begun a publish attempt. */
export function encodeDocPublishPauseStart(): Uint8Array {
  return new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]);
}

/** Client → server: this socket has frozen its editors (ordered readiness ack). */
export function encodeDocPublishReady(): Uint8Array {
  return new Uint8Array([MSG_DOC_PUBLISH_READY]);
}

/** Server → client: the publish attempt ended (committed or aborted); editors may unfreeze. */
export function encodeDocPublishPauseEnd(): Uint8Array {
  return new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]);
}

/** Parse the message type and payload from a raw binary frame. Returns null for empty frames. */
export function decodeMessage(data: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (data.length < 1) return null;
  return { type: data[0], payload: data.subarray(1) };
}

// ─── URL parsing ────────────────────────────────────────────────

export function parseCrdtUrl(url: string, host: string): { docPath: string } | null {
  const parsed = new URL(url, `http://${host}`);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith(CRDT_PATH_PREFIX)) {
    const raw = pathname.slice(CRDT_PATH_PREFIX.length).replace(/^\/+|\/+$/g, "");
    if (!raw) return null;
    return { docPath: "/" + raw };
  }

  return null;
}
