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
 *   0x14 LIVE_SECTIONS_BOOTSTRAP    — Server → Client: actor-captured live-section baseline
 *                                     (doc_session_id + full JSON state + trailing Yjs update)
 *   0x15 LIVE_SECTIONS_UPDATE       — Server → Client: ordered live-section update
 *                                     (optional Yjs update and/or full idempotent JSON state)
 *
 * The live-section frames (0x14/0x15) are the authoritative live section
 * interpretation channel (topology/existence, editability, pending, pause
 * mirror) that REPLACES the unordered application-WS `doc:structure-changed` /
 * `section:blocked|unblocked|gone` for live correctness. They EXTEND this
 * catalog — every message type above stays in force on the same socket. Body
 * text is never in the JSON portion; live bodies ride the trailing Yjs update,
 * and a structural change that touches fragments AND topology is delivered as
 * ONE frame (Yjs update + resulting `state` together) so a client never observes
 * half the structural fact. These frames must NOT be used as the publish-pause
 * handshake: the freeze/ready/end opcodes (0x10/0x11/0x12) stay authoritative
 * and `WireLiveSectionsState.publish_pause_join_mirror` is a join/UI mirror only. Scope is
 * live section authority ONLY — not the hub catalog, not `content:committed`
 * body reinstall, not `section:edit-rejected` (those stay on the app WS).
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
  WireLiveSectionsState,
} from "../types/shared.js";
import { expectJsonObject, parseJson, WireLiveSectionsState as WireLiveSectionsStateCodec } from "../types/shared.js";

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

// ─── Live-section frames (authoritative live section interpretation) ──
// Server → client only. These EXTEND the catalog; they do not replace any
// message type above. 0x13 is reserved-removed (live cross-section move went to
// REST); the next free opcodes are used.

export const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
export const MSG_LIVE_SECTIONS_UPDATE = 0x15;

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

// ─── Live-section frame interfaces + codec ───────────────────────
//
// A live-section frame carries a JSON header (a small, complete, idempotent
// snapshot of non-body state) and, for fragment changes, a trailing binary Yjs
// update. Body text is NEVER in the JSON. Envelope layout:
//
//   [opcode][json_len:uint32 BE][json bytes][yjs_update bytes...]
//
// The trailing bytes after the JSON header are the Yjs update. Presence is
// explicit: the bootstrap always carries one; the update carries one iff its
// JSON header sets `has_yjs_update: true` (so a zero-length update is
// unambiguous against "no update"). The JSON header is UTF-8.

/**
 * Actor-captured live-section baseline sent to a joining recipient. `state` is
 * the complete non-body snapshot; `yjs_update` is the full Y.Doc update whose
 * fragments back every id in `state.topology`.
 */
export interface LiveSectionsBootstrapFrame {
  doc_session_id: string;
  state: WireLiveSectionsState;
  yjs_update: Uint8Array;
}

/**
 * An ordered live-section update. `yjs_update` is present for fragment changes;
 * `state` is present whenever topology/editability/pending/pause-mirror changed.
 * A structural change delivers BOTH together in one frame so a client never
 * observes half the structural fact. A content-only edit may carry only
 * `yjs_update`; a lock/pending-only change may carry only `state`. This is NOT
 * the publish-pause handshake (opcodes 0x10/0x11/0x12 stay authoritative).
 */
export interface LiveSectionsUpdateFrame {
  yjs_update?: Uint8Array;
  state?: WireLiveSectionsState;
}

function encodeJsonHeaderFrame(opcode: number, header: unknown, trailing: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buf = new Uint8Array(1 + 4 + json.length + trailing.length);
  buf[0] = opcode;
  buf[1] = (json.length >>> 24) & 0xff;
  buf[2] = (json.length >>> 16) & 0xff;
  buf[3] = (json.length >>> 8) & 0xff;
  buf[4] = json.length & 0xff;
  buf.set(json, 5);
  buf.set(trailing, 5 + json.length);
  return buf;
}

/** Split a JSON-header frame payload (opcode already stripped) into header + trailing. */
function splitJsonHeaderPayload(payload: Uint8Array, label: string): { header: JsonObject; trailing: Uint8Array } {
  if (payload.length < 4) {
    throw new Error(`${label} frame truncated: missing 4-byte JSON length prefix`);
  }
  const jsonLen = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
  if (payload.length < 4 + jsonLen) {
    throw new Error(`${label} frame truncated: JSON length ${jsonLen} exceeds payload`);
  }
  const jsonBytes = payload.subarray(4, 4 + jsonLen);
  const header = expectJsonObject(parseJson(new TextDecoder().decode(jsonBytes)), `${label} header`);
  // Copy the trailing update out of the shared frame buffer so callers own it.
  return { header, trailing: payload.slice(4 + jsonLen) };
}

/** Server → client: encode the actor-captured live-section bootstrap frame. */
export function encodeLiveSectionsBootstrap(frame: LiveSectionsBootstrapFrame): Uint8Array {
  return encodeJsonHeaderFrame(
    MSG_LIVE_SECTIONS_BOOTSTRAP,
    { doc_session_id: frame.doc_session_id, state: frame.state },
    frame.yjs_update,
  );
}

/** Decode a `MSG_LIVE_SECTIONS_BOOTSTRAP` payload (opcode stripped). Fail-loud on malformed input. */
export function decodeLiveSectionsBootstrap(payload: Uint8Array): LiveSectionsBootstrapFrame {
  const { header, trailing } = splitJsonHeaderPayload(payload, "LiveSectionsBootstrap");
  const docSessionId = header["doc_session_id"];
  if (typeof docSessionId !== "string") {
    throw new Error(`LiveSectionsBootstrap.doc_session_id must be a string, got ${JSON.stringify(docSessionId)}`);
  }
  return {
    doc_session_id: docSessionId,
    state: WireLiveSectionsStateCodec.parse(header["state"], "LiveSectionsBootstrap.state"),
    yjs_update: trailing,
  };
}

/** Server → client: encode an ordered live-section update frame. */
export function encodeLiveSectionsUpdate(frame: LiveSectionsUpdateFrame): Uint8Array {
  const hasYjs = frame.yjs_update !== undefined;
  return encodeJsonHeaderFrame(
    MSG_LIVE_SECTIONS_UPDATE,
    { has_yjs_update: hasYjs, state: frame.state ?? null },
    hasYjs ? frame.yjs_update! : new Uint8Array(0),
  );
}

/** Decode a `MSG_LIVE_SECTIONS_UPDATE` payload (opcode stripped). Fail-loud on malformed input. */
export function decodeLiveSectionsUpdate(payload: Uint8Array): LiveSectionsUpdateFrame {
  const { header, trailing } = splitJsonHeaderPayload(payload, "LiveSectionsUpdate");
  const hasYjs = header["has_yjs_update"];
  if (typeof hasYjs !== "boolean") {
    throw new Error(`LiveSectionsUpdate.has_yjs_update must be a boolean, got ${JSON.stringify(hasYjs)}`);
  }
  const stateRaw = header["state"];
  const frame: LiveSectionsUpdateFrame = {};
  if (hasYjs) frame.yjs_update = trailing;
  if (stateRaw !== null && stateRaw !== undefined) {
    frame.state = WireLiveSectionsStateCodec.parse(stateRaw, "LiveSectionsUpdate.state");
  }
  return frame;
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
