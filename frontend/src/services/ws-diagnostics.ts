/**
 * Client-only, in-memory ring buffer of WS-related diagnostic events.
 *
 * Intended for the WS Diagnostics Console — an observational, never-behavior-
 * altering capture of everything the realtime layer does on the client:
 * incoming WebSocket frames, classification verdicts, socket lifecycle
 * transitions, BroadcastChannel auth-sync, tree-refresh scheduling, and tree
 * fetch fire / response summaries.
 *
 * No persistence across reloads. No backend capture. No dev-flag gating —
 * available to every logged-in user so field debugging does not require a
 * special build.
 *
 * Capture is strictly observational. Call sites MUST NOT change their existing
 * behavior when wiring into this buffer.
 */

export type WsDiagSource =
  | "ws-frame"
  | "ws-classification"
  | "ws-lifecycle"
  | "broadcast-auth"
  | "tree-refresh-schedule"
  | "tree-fetch"
  | "tree-fetch-result"
  | "worker-incoming"
  | "worker-outgoing"
  | "worker-lifecycle";

export interface WsDiagEntry {
  id: number;
  timestamp: number;
  source: WsDiagSource;
  type: string;
  summary: string;
  docPath?: string;
  payload: unknown;
}

export type WsDiagListener = (entry: WsDiagEntry) => void;

const CAPACITY = 200;

const buffer: WsDiagEntry[] = [];
let nextId = 1;
const listeners = new Set<WsDiagListener>();

export function recordWsDiag(input: {
  source: WsDiagSource;
  type: string;
  summary: string;
  docPath?: string;
  payload?: unknown;
}): WsDiagEntry {
  const entry: WsDiagEntry = {
    id: nextId++,
    timestamp: Date.now(),
    source: input.source,
    type: input.type,
    summary: input.summary,
    docPath: input.docPath,
    payload: input.payload,
  };
  buffer.push(entry);
  if (buffer.length > CAPACITY) {
    buffer.splice(0, buffer.length - CAPACITY);
  }
  for (const listener of listeners) {
    listener(entry);
  }
  return entry;
}

export function listWsDiagEntries(): WsDiagEntry[] {
  return buffer.slice();
}

export function clearWsDiag(): void {
  buffer.length = 0;
  for (const listener of listeners) {
    listener({
      id: -1,
      timestamp: Date.now(),
      source: "ws-lifecycle",
      type: "buffer_cleared",
      summary: "buffer cleared",
      payload: null,
    });
  }
}

export function subscribeWsDiag(listener: WsDiagListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function serializeWsDiag(): string {
  return JSON.stringify(buffer, null, 2);
}

export function getWsDiagCapacity(): number {
  return CAPACITY;
}
