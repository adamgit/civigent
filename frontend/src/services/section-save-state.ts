/**
 * User-facing section save state machine.
 *
 * Maps the internal persistence lifecycle (dirty/received/clean/deleting)
 * plus connection state into two durability tiers the user actually cares about:
 *
 *   1. Server hasn't received it  → data only in browser, close tab = lose it
 *   2. Server received it (RAM)   → data crossed the wire, safe to close tab
 *
 * The tier 2→canonical transition is a server-internal detail — the user's
 * risk does not change between "server has it in RAM" and "committed to
 * canonical". The meaningful safety boundary is tier 1→2: did the server
 * receive my edit? That's what MSG_UPDATE_RECEIVED signals.
 *
 * States:
 *   saved                  — no changes, or committed to canonical
 *   not_received           — edited but server has NOT confirmed receipt
 *   received_in_ram        — server confirmed receipt, data in server RAM
 *   send_failed_will_retry — WS down but reconnect in progress (data in browser only)
 *   send_failed_no_retry   — WS permanently failed (data loss guaranteed)
 *   receipt_timeout         — sent but no receipt ACK for too long (probable loss)
 *   deleting               — section removed from document, cleanup pending
 */

import type { CrdtConnectionState, SectionPersistenceState } from "./browser-fragment-replica-store";

export type SectionSaveState =
  | "saved"
  | "not_received"
  | "received_in_ram"
  | "send_failed_will_retry"
  | "send_failed_no_retry"
  | "receipt_timeout"
  | "deleting";

const RECEIPT_TIMEOUT_MS = 10_000;

export function resolveSaveState(
  persistenceState: SectionPersistenceState | undefined,
  connectionState: CrdtConnectionState,
  dirtySinceMs: number | undefined,
  nowMs: number,
): SectionSaveState {
  const state = persistenceState ?? "clean";

  if (state === "deleting") return "deleting";
  if (state === "clean") return "saved";
  if (state === "received") return "received_in_ram";

  // state === "dirty" — server has NOT confirmed receipt
  if (connectionState === "error" || connectionState === "disconnected") {
    return "send_failed_no_retry";
  }
  if (connectionState === "reconnecting" || connectionState === "connecting") {
    return "send_failed_will_retry";
  }

  // connected — check timeout
  if (dirtySinceMs !== undefined && (nowMs - dirtySinceMs) > RECEIPT_TIMEOUT_MS) {
    return "receipt_timeout";
  }

  return "not_received";
}

export interface SectionSaveInfo {
  fragmentKey: string;
  sectionLabel: string;
  state: SectionSaveState;
}

export const SAVE_STATE_META: Record<SectionSaveState, { label: string; color: string; dotClass: string }> = {
  saved:                  { label: "Saved",                    color: "text-green-700",  dotClass: "bg-green-500" },
  received_in_ram:        { label: "Server received",          color: "text-blue-600",   dotClass: "bg-blue-400" },
  not_received:           { label: "Sending\u2026",            color: "text-amber-600",  dotClass: "bg-amber-400" },
  send_failed_will_retry: { label: "Offline, will retry",      color: "text-amber-700",  dotClass: "bg-amber-500 animate-[pulse-dot_1.5s_ease-in-out_infinite]" },
  send_failed_no_retry:   { label: "Offline \u2014 unsaved",   color: "text-red-700",    dotClass: "bg-red-500" },
  receipt_timeout:        { label: "No response from server",  color: "text-red-600",    dotClass: "bg-red-400 animate-[pulse-dot_1.5s_ease-in-out_infinite]" },
  deleting:               { label: "Deleting\u2026",           color: "text-amber-600",  dotClass: "bg-amber-300" },
};

/** Aggregate priority: worst state wins for the top-level indicator. */
const STATE_PRIORITY: SectionSaveState[] = [
  "send_failed_no_retry",
  "receipt_timeout",
  "send_failed_will_retry",
  "not_received",
  "received_in_ram",
  "deleting",
  "saved",
];

export function worstSaveState(states: SectionSaveState[]): SectionSaveState {
  if (states.length === 0) return "saved";
  let worst = STATE_PRIORITY.length - 1;
  for (const s of states) {
    const idx = STATE_PRIORITY.indexOf(s);
    if (idx < worst) worst = idx;
  }
  return STATE_PRIORITY[worst];
}
