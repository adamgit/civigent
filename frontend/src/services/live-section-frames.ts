/**
 * Frontend decoder for the authoritative live-section frames on the DocSession
 * CRDT socket. Mirror of the backend codec in `backend/src/ws/crdt-ws-frames.ts`
 * (the constants and envelope layout MUST match). Server → client only.
 *
 * Envelope (opcode already stripped by the provider's `data[0]` / `subarray(1)`):
 *   [json_len:uint32 BE][json bytes][yjs_update bytes...]
 *
 * The JSON header is the small, complete, idempotent non-body `state` (+ frame
 * metadata); the trailing bytes are the Yjs update. Body text is never in JSON.
 * Decoded frames feed `LiveSectionReplica.applyBootstrap` / `applyUpdate`, which
 * apply them atomically and notify React only after a full apply.
 */

import { parseJson, expectJsonObject, WireLiveSectionsState } from "../types/shared";
import type { LiveBootstrapInput, LiveUpdateInput } from "./live-section-replica";

// Opcodes — MUST match backend `crdt-ws-frames.ts`.
export const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
export const MSG_LIVE_SECTIONS_UPDATE = 0x15;

interface SplitFrame {
  header: Record<string, unknown>;
  trailing: Uint8Array;
}

/** Split a JSON-header frame payload (opcode already stripped) into header + trailing. */
function splitJsonHeaderPayload(payload: Uint8Array, label: string): SplitFrame {
  if (payload.length < 4) {
    throw new Error(`${label} frame truncated: missing 4-byte JSON length prefix`);
  }
  const jsonLen = ((payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]) >>> 0;
  if (payload.length < 4 + jsonLen) {
    throw new Error(`${label} frame truncated: JSON length ${jsonLen} exceeds payload`);
  }
  const jsonText = new TextDecoder().decode(payload.subarray(4, 4 + jsonLen));
  const header = expectJsonObject(parseJson(jsonText), `${label} header`) as Record<string, unknown>;
  // Copy the trailing update out of the shared frame buffer so callers own it.
  return { header, trailing: payload.slice(4 + jsonLen) };
}

/** Decode a `MSG_LIVE_SECTIONS_BOOTSTRAP` payload (opcode stripped). Fail-loud. */
export function decodeLiveSectionsBootstrap(payload: Uint8Array): LiveBootstrapInput {
  const { header, trailing } = splitJsonHeaderPayload(payload, "LiveSectionsBootstrap");
  const docSessionId = header["doc_session_id"];
  if (typeof docSessionId !== "string") {
    throw new Error(`LiveSectionsBootstrap.doc_session_id must be a string, got ${JSON.stringify(docSessionId)}`);
  }
  return {
    docSessionId,
    state: WireLiveSectionsState.parse(header["state"] as never, "LiveSectionsBootstrap.state"),
    yjsUpdate: trailing,
  };
}

/** Decode a `MSG_LIVE_SECTIONS_UPDATE` payload (opcode stripped). Fail-loud. */
export function decodeLiveSectionsUpdate(payload: Uint8Array): LiveUpdateInput {
  const { header, trailing } = splitJsonHeaderPayload(payload, "LiveSectionsUpdate");
  const hasYjs = header["has_yjs_update"];
  if (typeof hasYjs !== "boolean") {
    throw new Error(`LiveSectionsUpdate.has_yjs_update must be a boolean, got ${JSON.stringify(hasYjs)}`);
  }
  const out: LiveUpdateInput = {};
  if (hasYjs) out.yjsUpdate = trailing;
  const rawState = header["state"];
  if (rawState !== null && rawState !== undefined) {
    out.state = WireLiveSectionsState.parse(rawState as never, "LiveSectionsUpdate.state");
  }
  return out;
}

/**
 * Route a raw server frame (opcode + payload) into a replica. Returns true if the
 * frame was a live-section frame and was applied, false otherwise (so the caller
 * can fall through to its other opcode handling). The replica applies each frame
 * fully before notifying subscribers, so React never observes a half-applied fact.
 */
export function routeLiveSectionFrame(
  opcode: number,
  payload: Uint8Array,
  replica: { applyBootstrap(i: LiveBootstrapInput): void; applyUpdate(i: LiveUpdateInput): void },
): boolean {
  switch (opcode) {
    case MSG_LIVE_SECTIONS_BOOTSTRAP:
      replica.applyBootstrap(decodeLiveSectionsBootstrap(payload));
      return true;
    case MSG_LIVE_SECTIONS_UPDATE:
      replica.applyUpdate(decodeLiveSectionsUpdate(payload));
      return true;
    default:
      return false;
  }
}
