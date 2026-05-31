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
 * Binary protocol:
 *   0x00 SYNC_STEP_1                — State vector (client→server and server→client)
 *   0x01 SYNC_STEP_2                — State diff  (client→server and server→client)
 *   0x02 YJS_UPDATE                 — Incremental Yjs update (bidirectional)
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
 *
 * (4020 idle_timeout is REMOVED — there is no idle timer in this architecture.)
 */

import * as Y from "yjs";
import type {
  DocumentReplacementNoticePayload,
  ModeTransitionRequest,
  ModeTransitionResult,
} from "../types/shared.js";

// ─── Message type constants ──────────────────────────────────────

export const MSG_SYNC_STEP_1 = 0;
export const MSG_SYNC_STEP_2 = 1;
export const MSG_YJS_UPDATE = 2;
export const MSG_AWARENESS = 3;
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

// ─── Cross-section move (MW-10) ──────────────────────────────────
// Client → Server: request a backend-owned structural reorder of a section
// relative to a sibling (spec 05 §Structural Normalization — structural moves
// are backend-owned via the Y.transact primitive; Y.js has no moveTo between
// top-level types). Carries JSON `SectionMoveRequest`. The actual Y.Doc reorder
// runs inside the DocSession actor lane. 0x13 is the next free opcode after the
// publish-pause range; 0x08 stays permanently reserved-removed.
export const MSG_SECTION_MOVE_REQUEST = 0x13;

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

// ─── Cross-section move codec (MW-10) ────────────────────────────

/** Client → server: request a backend-owned section reorder relative to a sibling. */
export interface SectionMoveRequest {
  /** Heading path of the section being moved. */
  sourceHeadingPath: string[];
  /** Heading path of the sibling to position relative to. */
  targetHeadingPath: string[];
  /** Place the moved section immediately before or after the target sibling. */
  position: "before" | "after";
}

/** Client → server: encode a section-move request as a JSON binary frame. */
export function encodeSectionMoveRequest(req: SectionMoveRequest): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(req));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_SECTION_MOVE_REQUEST;
  msg.set(json, 1);
  return msg;
}

/** Parse a section-move request payload (JSON body, no leading opcode). Returns
 *  null when the payload is malformed or missing required fields. */
export function decodeSectionMoveRequest(payload: Uint8Array): SectionMoveRequest | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(payload)) as Partial<SectionMoveRequest>;
    if (
      !Array.isArray(obj.sourceHeadingPath)
      || !Array.isArray(obj.targetHeadingPath)
      || (obj.position !== "before" && obj.position !== "after")
      || !obj.sourceHeadingPath.every((s) => typeof s === "string")
      || !obj.targetHeadingPath.every((s) => typeof s === "string")
    ) {
      return null;
    }
    return {
      sourceHeadingPath: obj.sourceHeadingPath,
      targetHeadingPath: obj.targetHeadingPath,
      position: obj.position,
    };
  } catch {
    return null;
  }
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
