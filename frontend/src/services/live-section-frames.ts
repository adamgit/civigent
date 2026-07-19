import { parseJson, expectJsonObject, WireLiveSectionsState } from "../types/shared";
import type { LiveBootstrapInput, LiveSectionReplica, LiveUpdateInput } from "./live-section-replica";

export const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
export const MSG_LIVE_SECTIONS_UPDATE = 0x15;

interface SplitFrame {
  header: Record<string, unknown>;
  trailing: Uint8Array;
}

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
  return { header, trailing: payload.slice(4 + jsonLen) };
}

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

export function routeLiveSectionFrame(
  opcode: number,
  payload: Uint8Array,
  replica: LiveSectionReplica,
): boolean {
  switch (opcode) {
    case MSG_LIVE_SECTIONS_UPDATE:
      replica.ingestUpdate(decodeLiveSectionsUpdate(payload));
      return true;
    case MSG_LIVE_SECTIONS_BOOTSTRAP:
      return false;
    default:
      return false;
  }
}
