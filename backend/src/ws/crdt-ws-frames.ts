/**
 * CRDT binary WebSocket frame codec — message type constants, encode, decode.
 * Pure functions only. No session state, no network I/O.
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

export const MSG_SYNC_STEP_1 = 0;
export const MSG_SYNC_STEP_2 = 1;
export const MSG_YJS_UPDATE = 2;
export const MSG_AWARENESS = 3;
export const MSG_UPDATE_ACK = 4;
export const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0B;
export const MSG_MODE_TRANSITION_REQUEST = 0x0C;
export const MSG_MODE_TRANSITION_RESULT = 0x0D;
export const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
export const MSG_DOC_PUBLISH_READY = 0x11;
export const MSG_DOC_PUBLISH_PAUSE_END = 0x12;
export const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
export const MSG_LIVE_SECTIONS_UPDATE = 0x15;

export const WS_CLOSE_AUTH_REQUIRED = 4001;
export const WS_CLOSE_INVALID_URL = 4010;
export const WS_CLOSE_AUTH_FAILED = 4011;
export const WS_CLOSE_AUTHORIZATION_FAILED = 4013;
export const WS_CLOSE_YDOC_INIT_FAILED = 4014;
export const WS_CLOSE_SESSION_ENDED = 4021;
export const WS_CLOSE_DOCUMENT_REPLACED = 4022;
export const WS_CLOSE_REASON_DOCUMENT_REPLACED = "document_replaced";
export const WS_CLOSE_REASON_STALE_DOC_SESSION = "stale_doc_session";
export const WS_CLOSE_SUPERSEDED = 4023;
export const WS_CLOSE_ADMIN_REBUILD = 4024;
export const WS_CLOSE_SYSTEM_LOCKDOWN = 4025;
export const WS_CLOSE_REASON_MAX_LENGTH = 123;

export const CRDT_PATH_PREFIX = "/ws/crdt/";

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

export function encodeUpdateAck(count: number): Uint8Array {
  const buf = new Uint8Array(5);
  buf[0] = MSG_UPDATE_ACK;
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

export function encodeDocPublishPauseStart(): Uint8Array {
  return new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]);
}

export function encodeDocPublishReady(): Uint8Array {
  return new Uint8Array([MSG_DOC_PUBLISH_READY]);
}

export function encodeDocPublishPauseEnd(): Uint8Array {
  return new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]);
}

export interface LiveSectionsBootstrapFrame {
  doc_session_id: string;
  state: WireLiveSectionsState;
  yjs_update: Uint8Array;
}

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
  return { header, trailing: payload.slice(4 + jsonLen) };
}

export function encodeLiveSectionsBootstrap(frame: LiveSectionsBootstrapFrame): Uint8Array {
  return encodeJsonHeaderFrame(
    MSG_LIVE_SECTIONS_BOOTSTRAP,
    { doc_session_id: frame.doc_session_id, state: frame.state },
    frame.yjs_update,
  );
}

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

export function encodeLiveSectionsUpdate(frame: LiveSectionsUpdateFrame): Uint8Array {
  const hasYjs = frame.yjs_update !== undefined;
  return encodeJsonHeaderFrame(
    MSG_LIVE_SECTIONS_UPDATE,
    { has_yjs_update: hasYjs, state: frame.state ?? null },
    hasYjs ? frame.yjs_update! : new Uint8Array(0),
  );
}

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

export function decodeMessage(data: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (data.length < 1) return null;
  return { type: data[0], payload: data.subarray(1) };
}

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
