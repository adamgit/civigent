/**
 * CRDT binary protocol — message type constants, encode, decode.
 *
 * Pure functions only. No session state, no network I/O.
 * All encode helpers return a Uint8Array ready to send over any transport.
 *
 * Binary protocol:
 *   0x00 SYNC_STEP_1          — State vector (client→server and server→client)
 *   0x01 SYNC_STEP_2          — State diff  (client→server and server→client)
 *   0x02 YJS_UPDATE            — Incremental Yjs update (bidirectional)
 *   0x03 AWARENESS             — Awareness data
 *   0x04 SESSION_FLUSHED       — Server → Client notification
 *   0x05 SECTION_FOCUS         — Client → Server heading path (segments separated by \x00)
 *   0x06 SESSION_FLUSH_STARTED — Server → Client: flush beginning
 *   0x07 ACTIVITY_PULSE        — Client → Server: human is actively editing (debounced ~2-3s)
 *   0x08 STRUCTURE_WILL_CHANGE — Server → Client: about to restructure fragments (old→new key mapping)
 *   0x09 SECTION_MUTATE        — Client → Server: replace fragment content (JSON { fragmentKey, markdown })
 *   0x0A MUTATE_RESULT         — Server → Client: response to SECTION_MUTATE (JSON { success, error? })
 *   0x0B RESTORE_NOTIFICATION  — Server → Client: document restored (JSON RestoreNotificationPayload)
 *
 * Close codes (application-level, above 4000):
 *   4001 — auth_required
 *   4010 — invalid_url
 *   4011 — auth_failed / token_expired
 *   4013 — authorization_failed
 *   4014 — ydoc_init_failed
 *   4020 — idle_timeout
 *   4021 — session_ended: last editor disconnected; observers fall back to REST and reconnect
 *   4022 — document_restored: restore invalidated session; all clients reconnect immediately (no backoff)
 *   4023 — superseded_by_new_tab: same user opened a new editor tab for this document
 */

import * as Y from "yjs";
import type { RestoreNotificationPayload } from "../types/shared.js";

// ─── Message type constants ──────────────────────────────────────

export const MSG_SYNC_STEP_1 = 0;
export const MSG_SYNC_STEP_2 = 1;
export const MSG_YJS_UPDATE = 2;
export const MSG_AWARENESS = 3;
export const MSG_SESSION_FLUSHED = 4;
export const MSG_SECTION_FOCUS = 5;
export const MSG_SESSION_FLUSH_STARTED = 6;
export const MSG_ACTIVITY_PULSE = 7;
export const MSG_STRUCTURE_WILL_CHANGE = 8;
export const MSG_SECTION_MUTATE = 9;
export const MSG_MUTATE_RESULT = 10;
export const MSG_RESTORE_NOTIFICATION = 0x0B;

// ─── URL routing constants ────────────────────────────────────────

export const CRDT_PATH_PREFIX = "/ws/crdt/";
export const CRDT_OBSERVE_PATH_PREFIX = "/ws/crdt-observe/";

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

export function encodeSessionFlushStarted(): Uint8Array {
  return new Uint8Array([MSG_SESSION_FLUSH_STARTED]);
}

export function encodeSessionFlushed(writtenKeys: string[], deletedKeys: string[]): Uint8Array {
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

export function encodeStructureWillChange(
  restructures: Array<{ oldKey: string; newKeys: string[] }>,
): Uint8Array {
  const json = JSON.stringify(restructures);
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_STRUCTURE_WILL_CHANGE;
  buf.set(payload, 1);
  return buf;
}

export function encodeMutateResult(success: boolean, error?: string): Uint8Array {
  const json = JSON.stringify(error ? { success, error } : { success });
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_MUTATE_RESULT;
  buf.set(payload, 1);
  return buf;
}

export function encodeRestoreNotification(payload: RestoreNotificationPayload): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_RESTORE_NOTIFICATION;
  msg.set(json, 1);
  return msg;
}

/** Parse the message type and payload from a raw binary frame. Returns null for empty frames. */
export function decodeMessage(data: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (data.length < 1) return null;
  return { type: data[0], payload: data.subarray(1) };
}

// ─── URL parsing ────────────────────────────────────────────────

export function parseCrdtUrl(url: string, host: string): { docPath: string; observe: boolean } | null {
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
